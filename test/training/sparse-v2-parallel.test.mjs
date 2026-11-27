#!/usr/bin/env node
// Contract tests only: no evaluator compilation, WASM instantiation, or chess search.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  makeExpected, parseCpuList, planBlocks, planJobs, readBound, retainExecutable,
  sha256, signature, spawnVerifiedNode, summarize, validateBlock, validateConfig,
} from '../../tools/sparse_eval_v2/parallel.mjs';

const config = JSON.parse(await fs.readFile(new URL('../../eval/sparse-pesto-v2/PARALLEL-CONFIG.json', import.meta.url)));
validateConfig(config);
const phases = ['opening', 'middlegame', 'endgame'];
const roots = Array.from({ length: 72 }, (_, index) => ({ id: `root-${index}`, fen: `authored-${index}`,
  phase: phases[Math.floor(index / 24)], family: index }));
const selection = { target: 'wasm-simd', variant: 'fused' };
const baseSignature = { nodes: 36000, qnodes: 12000, depth: 5, attempted_depth: 6,
  score: 25, move: 'e2e4', stop_reason: 'node_limit', cutoffs: 1234, researches: 9, tt_saturated: false };
const references = roots.flatMap(root => [0, 1, 2].map(replicate => ({ ...baseSignature,
  stage: 'full', model: 'full', mode: 'candidate', target: selection.target, variant: selection.variant,
  requested_nodes: 36000, root: root.id, replicate, scorePov: 'white' })));
const expected = makeExpected(references, roots, selection, config);
let passed = 0;
function test(name, fn) { fn(); ++passed; process.stdout.write(`ok ${passed} - ${name}\n`); }

test('balanced fixed work, root inventory, and phase assignment', () => {
  assert.deepEqual(planBlocks(config).map(block => block.workers), [1, 2, 4, 2, 4, 1, 4, 1, 2]);
  const coverage = new Map();
  for (const block of planBlocks(config)) {
    const jobs = planJobs(roots, block.workers, block.replicate);
    assert.equal(jobs.length, 72);
    assert.equal(new Set(jobs.map(job => job.root)).size, 72);
    for (let worker = 0; worker < block.workers; ++worker) {
      const assigned = jobs.filter(job => job.worker === worker);
      assert.equal(assigned.length, 72 / block.workers);
      for (const phase of phases) assert.equal(assigned.filter(job => job.phase === phase).length, 24 / block.workers);
    }
    for (const job of jobs) {
      const key = `${job.workers}:${job.root}`;
      coverage.set(key, (coverage.get(key) || 0) + 1);
    }
  }
  assert.equal(coverage.size, 3 * 72);
  assert.ok([...coverage.values()].every(count => count === 3));
  assert.throws(() => validateConfig({ ...config, workerCounts: [1, 4] }), /inventory/);
  assert.throws(() => validateConfig({ ...config, nodeFlags: [] }), /Node flags/);
});

test('cost signatures reject missing, duplicate, cross-mode and disagreeing rows', () => {
  assert.equal(Object.keys(expected).length, 72);
  assert.throws(() => makeExpected(references.slice(1), roots, selection, config), /incomplete/);
  assert.throws(() => makeExpected([...references, references[0]], roots, selection, config), /duplicate/);
  const changed = structuredClone(references); changed[1].score += 1;
  assert.throws(() => makeExpected(changed, roots, selection, config), /replicates disagree/);
  const wrongMode = structuredClone(references); wrongMode[0].mode = 'hce';
  assert.throws(() => makeExpected(wrongMode, roots, selection, config), /incomplete/);
  const wrongModel = structuredClone(references); wrongModel[0].model = 'pruned';
  assert.throws(() => makeExpected(wrongModel, roots, selection, config), /incomplete/);
  assert.throws(() => signature({ ...baseSignature, qnodes: NaN }), /qnodes/);
  assert.throws(() => signature({ ...baseSignature, attempted_depth: undefined }), /attempted/);
});

function fakeBlock(spec) {
  const latency = { 1: 10000000, 2: 12000000, 4: 16000000 }[spec.workers];
  const jobs = planJobs(roots, spec.workers, spec.replicate);
  return { ...spec, wallElapsedNs: 72 / spec.workers * latency,
    rows: jobs.map(job => ({ ...job, ...baseSignature, scorePov: 'white', requested_nodes: 36000, elapsed_ns: latency })),
    workerResults: Array.from({ length: spec.workers }, (_, worker) => ({ worker, ...spec,
      cpuUsage: { user: 72 / spec.workers * latency / 1000, system: 0 },
      resources: { maxRSS: 1024 }, memoryReady: { rss: 512 * 1024 }, memoryEnd: { rss: 768 * 1024 },
      info: { memoryBytes: 32 * 1024 * 1024 } })) };
}

test('every measured job must preserve its assignment and exact signature', () => {
  const block = fakeBlock({ workers: 4, replicate: 2 });
  assert.equal(validateBlock(block, roots, expected, config), true);
  const changed = structuredClone(block); changed.rows[0].score += 1;
  assert.throws(() => validateBlock(changed, roots, expected, config), /signature changed/);
  const missing = structuredClone(block); missing.rows.pop();
  assert.throws(() => validateBlock(missing, roots, expected, config), /incomplete/);
  const duplicate = structuredClone(block); duplicate.rows[1] = duplicate.rows[0];
  assert.throws(() => validateBlock(duplicate, roots, expected, config), /duplicate/);
  const reassigned = structuredClone(block); reassigned.rows[0].worker = 1;
  assert.throws(() => validateBlock(reassigned, roots, expected, config), /reassigned/);
  const badCpu = structuredClone(block); badCpu.workerResults[0].cpuUsage.user = NaN;
  assert.throws(() => validateBlock(badCpu, roots, expected, config), /resource accounting/);
});

test('throughput uses fixed total work while concurrency latency may worsen', () => {
  const blocks = planBlocks(config).map(fakeBlock), result = summarize(blocks, config);
  assert.deepEqual(result.map(row => row.searches), [216, 216, 216]);
  assert.deepEqual(result.map(row => row.distinctRoots), [72, 72, 72]);
  assert.deepEqual(result.map(row => row.actualNodes), [7776000, 7776000, 7776000]);
  assert.ok(Math.abs(result[1].throughputRatioToOneWorker - 5 / 3) < 1e-12);
  assert.equal(result[2].throughputRatioToOneWorker, 2.5);
  assert.deepEqual(result.map(row => row.meanSearchLatencyRatioToOneWorker), [1, 1.2, 1.6]);
  assert.equal(result[2].maximumSumOfWorkerPeakRssBytes, 4 * 1024 * 1024);
  assert.equal(result[2].fixedWasmLinearMemoryBytes, 4 * 32 * 1024 * 1024);
  assert.throws(() => summarize(blocks.slice(1), config), /incomplete block/);
  const duplicated = [...blocks.slice(1), blocks[1]];
  assert.throws(() => summarize(duplicated, config), /incomplete block/);
});

test('CPU affinity parsing rejects ambiguous ranges', () => {
  assert.deepEqual(parseCpuList('0-2,4,8-9'), [0, 1, 2, 4, 8, 9]);
  assert.throws(() => parseCpuList(undefined), /unavailable/);
  assert.throws(() => parseCpuList('0-2,2'), /overlapping/);
  assert.throws(() => parseCpuList('4-1'), /invalid/);
  assert.throws(() => parseCpuList('1,'), /invalid/);
});

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'chessy-parallel-contract-'));
try {
  const filename = path.join(temporary, 'bytes.bin'), original = Buffer.from('retained input\n');
  await fs.writeFile(filename, original);
  const record = { bytes: original.length, sha256: sha256(original) };
  const consumed = await readBound(filename, record);
  await fs.writeFile(filename, Buffer.from('changed source\n'));
  assert.deepEqual(consumed, original);
  await assert.rejects(readBound(filename, record), /authenticated bytes changed/);
  ++passed; process.stdout.write(`ok ${passed} - hashes and consumes retained input bytes\n`);

  if (process.platform !== 'linux') throw new Error('verified-inode launch contract requires Linux');
  const cpu = parseCpuList((await fs.readFile('/proc/self/status', 'utf8')).match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1])[0];
  const scriptPath = path.join(temporary, 'ipc-probe.mjs');
  await fs.writeFile(scriptPath, `import fs from 'node:fs/promises';
const status = await fs.readFile('/proc/self/status', 'utf8');
process.on('message', message => {
  if (message.kind !== 'go') throw new Error('bad probe message');
  process.send({kind:'done', argument:process.argv[2]}, () => process.disconnect());
});
process.send({kind:'ready', flags:process.execArgv, affinity:status.match(/^Cpus_allowed_list:\\s*(.+)$/m)[1]});
`, { mode: 0o444 });
  const node = await retainExecutable(process.execPath), taskset = await retainExecutable('/usr/bin/taskset');
  const script = await fs.open(scriptPath, 'r');
  try {
    const child = spawnVerifiedNode({ node, taskset, script, flags: config.nodeFlags, cpu, args: ['sentinel'] });
    let stdout = '', stderr = '', ready = false, done = false;
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('verified IPC launch timed out')); }, 5000);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('message', message => {
        try {
          if (message.kind === 'ready' && !ready) {
            assert.deepEqual(message.flags, config.nodeFlags); assert.equal(message.affinity, String(cpu));
            ready = true; child.send({ kind: 'go' });
          } else if (message.kind === 'done' && ready && !done) {
            assert.equal(message.argument, 'sentinel'); done = true;
          } else throw new Error('unexpected probe message');
        } catch (error) { child.kill('SIGKILL'); clearTimeout(timer); reject(error); }
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        try { assert.equal(code, 0, stderr); assert.equal(signal, null); assert.equal(stdout, ''); assert.equal(stderr, '');
          assert.ok(ready && done); resolve(); } catch (error) { reject(error); }
      });
    });
    ++passed; process.stdout.write(`ok ${passed} - verified executable descriptors preserve pinned Node IPC and flags\n`);
  } finally { await Promise.allSettled([script.close(), node.handle.close(), taskset.handle.close()]); }
} finally { await fs.rm(temporary, { recursive: true, force: true }); }
process.stdout.write(`${passed} parallel contract tests passed; zero chess engine calls.\n`);
