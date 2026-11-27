#!/usr/bin/env node
// Research-only independent-process throughput study. No search-tree parallelism.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SIGNATURE_KEYS = Object.freeze([
  'nodes', 'qnodes', 'depth', 'attempted_depth', 'score', 'move', 'stop_reason',
  'cutoffs', 'researches', 'tt_saturated',
]);
const NODE_FLAGS = Object.freeze(['--no-liftoff', '--no-wasm-lazy-compilation']);
const REGISTRATION_SCHEMA = 'chessy.sparse-v2-parallel-registration.v1';
const RESULTS_SCHEMA = 'chessy.sparse-v2-parallel-results.v1';
const SELF = fileURLToPath(import.meta.url);
export const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const identical = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };
const safeInteger = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;

function boundedInteger(text, name, minimum, maximum) {
  requireThat(/^(0|[1-9][0-9]*)$/.test(String(text)), `${name} must be an integer`);
  const value = Number(text);
  requireThat(safeInteger(value, minimum) && value <= maximum, `${name} is outside its bound`);
  return value;
}

export function validateConfig(config) {
  requireThat(config.schema === 'chessy.sparse-v2-parallel-config.v1' && config.researchOnly === true,
    'unsupported parallel configuration');
  requireThat(identical(config.workerCounts, [1, 2, 4]) && config.replicates === 3 &&
    config.roots === 72 && config.nodes === 36000 && config.maximumDepth === 30,
  'worker/job/search inventory differs from this bounded protocol');
  requireThat(identical(config.nodeFlags, NODE_FLAGS), 'optimized Node flags changed');
  requireThat(config.searchWarmupCycles === 4 && config.searchWarmupNodes === 10000 &&
    Array.isArray(config.warmupFens) && config.warmupFens.length === 4 &&
    new Set(config.warmupFens).size === 4, 'warmup inventory changed');
  requireThat(config.blockTimeoutMs === 120000 && config.model === 'full', 'unbounded or different study');
  for (const key of ['costRegistrationSha256', 'costResultsSha256', 'costAuditSha256', 'fullWeightsSha256']) {
    requireThat(/^[0-9a-f]{64}$/.test(config[key]), `missing ${key}`);
  }
  return config;
}

export function signature(row) {
  requireThat(row && typeof row === 'object', 'missing search signature');
  for (const key of ['nodes', 'qnodes', 'depth', 'cutoffs', 'researches']) {
    requireThat(safeInteger(row[key]), `invalid ${key}`);
  }
  requireThat(row.attempted_depth === null || safeInteger(row.attempted_depth), 'invalid attempted depth');
  requireThat(Number.isSafeInteger(row.score) && typeof row.tt_saturated === 'boolean', 'invalid score/TT flag');
  requireThat(row.move === null || /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(row.move), 'invalid move');
  requireThat(['max_depth', 'time_limit', 'node_limit', 'mate', 'game_over'].includes(row.stop_reason),
    'invalid stop reason');
  return Object.fromEntries(SIGNATURE_KEYS.map(key => [key, row[key]]));
}

export function makeExpected(rows, roots, selection, config) {
  requireThat(roots.length === config.roots && new Set(roots.map(row => row.id)).size === config.roots &&
    new Set(roots.map(row => row.fen)).size === config.roots &&
    new Set(roots.map(row => row.family)).size === config.roots, 'duplicate or missing cost roots');
  for (const phase of ['opening', 'middlegame', 'endgame']) {
    requireThat(roots.filter(row => row.phase === phase).length === 24, `incorrect ${phase} coverage`);
  }
  const expected = new Map(), seen = new Set(), rootIds = new Set(roots.map(row => row.id));
  for (const row of rows) {
    if (row.stage !== 'full' || row.model !== 'full' || row.mode !== 'candidate' ||
        row.target !== selection.target || row.variant !== selection.variant ||
        row.requested_nodes !== config.nodes) continue;
    requireThat(rootIds.has(row.root) && safeInteger(row.replicate) && row.replicate < config.replicates,
      'unexpected cost signature root/replicate');
    const key = `${row.root}:${row.replicate}`;
    requireThat(!seen.has(key), 'duplicate cost signature');
    seen.add(key);
    const value = signature(row);
    requireThat(row.scorePov === 'white' && value.nodes <= config.nodes && !value.tt_saturated,
      'unsupported cost signature semantics');
    if (expected.has(row.root)) requireThat(identical(expected.get(row.root), value), 'cost replicates disagree');
    expected.set(row.root, value);
  }
  requireThat(seen.size === config.roots * config.replicates && expected.size === config.roots,
    'incomplete selected full-model cost signatures');
  return Object.fromEntries(roots.map(row => [row.id, expected.get(row.id)]));
}

export function planBlocks(config) {
  const result = [];
  for (let replicate = 0; replicate < config.replicates; ++replicate) {
    const counts = [...config.workerCounts.slice(replicate), ...config.workerCounts.slice(0, replicate)];
    for (const workers of counts) result.push({ replicate, workers });
  }
  return result;
}

export function planJobs(roots, workers, replicate) {
  requireThat([1, 2, 4].includes(workers) && safeInteger(replicate) && replicate < 3, 'invalid block');
  const indices = roots.map((_, index) => index);
  // The same three root orders apply to every worker count.
  const ordered = replicate === 1 ? indices.reverse() : replicate === 2 ?
    [...indices.slice(24), ...indices.slice(0, 24)] : indices;
  return ordered.map((index, ordinal) => ({ index, root: roots[index].id, phase: roots[index].phase,
    ordinal, worker: ordinal % workers, replicate, workers }));
}

export function validateBlock(block, roots, expected, config) {
  const planned = planJobs(roots, block.workers, block.replicate);
  requireThat(block.rows.length === planned.length && safeInteger(block.wallElapsedNs, 1), 'incomplete timed block');
  const byOrdinal = new Map();
  for (const row of block.rows) {
    requireThat(safeInteger(row.ordinal) && !byOrdinal.has(row.ordinal), 'duplicate/invalid measured job');
    const job = planned[row.ordinal];
    requireThat(job && ['root', 'phase', 'worker', 'replicate', 'workers', 'index'].every(key => row[key] === job[key]),
      'job was reassigned or changed');
    requireThat(row.requested_nodes === config.nodes && row.scorePov === 'white' && safeInteger(row.elapsed_ns, 1),
      'invalid measured search metadata');
    requireThat(identical(signature(row), expected[row.root]), `search signature changed for ${row.root}`);
    byOrdinal.set(row.ordinal, row);
  }
  requireThat(block.workerResults.length === block.workers &&
    new Set(block.workerResults.map(row => row.worker)).size === block.workers, 'worker results incomplete');
  for (const worker of block.workerResults) {
    requireThat(safeInteger(worker.worker) && worker.worker < block.workers &&
      worker.workers === block.workers && worker.replicate === block.replicate, 'invalid worker identity');
    requireThat(safeInteger(worker.cpuUsage?.user) && safeInteger(worker.cpuUsage?.system) &&
      safeInteger(worker.resources?.maxRSS) && safeInteger(worker.memoryReady?.rss) &&
      safeInteger(worker.memoryEnd?.rss) && safeInteger(worker.info?.memoryBytes, 1), 'invalid worker resource accounting');
  }
  return true;
}

function quantile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}

export function summarize(blocks, config) {
  requireThat(blocks.length === config.replicates * config.workerCounts.length &&
    new Set(blocks.map(b => `${b.workers}:${b.replicate}`)).size === blocks.length, 'incomplete block inventory');
  const result = config.workerCounts.map(workers => {
    const own = blocks.filter(block => block.workers === workers);
    requireThat(own.length === config.replicates, 'missing worker-count replicate');
    const rows = own.flatMap(block => block.rows), durations = rows.map(row => row.elapsed_ns);
    requireThat(rows.length === config.roots * config.replicates, 'incorrect fixed total work');
    const elapsedNs = own.reduce((sum, block) => sum + block.wallElapsedNs, 0);
    const actualNodes = rows.reduce((sum, row) => sum + row.nodes, 0);
    const cpuUs = own.reduce((sum, block) => sum + block.workerResults.reduce((inner, worker) =>
      inner + worker.cpuUsage.user + worker.cpuUsage.system, 0), 0);
    return { workers, blocks: own.length, searches: rows.length, distinctRoots: config.roots, actualNodes,
      totalBatchWallNs: elapsedNs, actualNodesPerSecond: actualNodes * 1e9 / elapsedNs,
      searchesPerSecond: rows.length * 1e9 / elapsedNs,
      searchCallLatencyNs: { mean: durations.reduce((a, b) => a + b, 0) / durations.length,
        median: quantile(durations, 0.5), p95: quantile(durations, 0.95), min: Math.min(...durations), max: Math.max(...durations) },
      workerCpuTimeUs: cpuUs, observedWorkerCpuSecondsPerBatchWallSecond: cpuUs * 1000 / elapsedNs,
      maximumSumOfWorkerPeakRssBytes: Math.max(...own.map(block => block.workerResults.reduce((sum, worker) =>
        sum + worker.resources.maxRSS * 1024, 0))),
      maximumSumOfWorkerReadyRssBytes: Math.max(...own.map(block => block.workerResults.reduce((sum, worker) =>
        sum + worker.memoryReady.rss, 0))),
      maximumSumOfWorkerEndRssBytes: Math.max(...own.map(block => block.workerResults.reduce((sum, worker) =>
        sum + worker.memoryEnd.rss, 0))),
      fixedWasmLinearMemoryBytes: own[0].workerResults.reduce((sum, worker) => sum + worker.info.memoryBytes, 0),
      blockActualNodesPerSecond: own.map(block => block.rows.reduce((sum, row) => sum + row.nodes, 0) * 1e9 / block.wallElapsedNs) };
  });
  for (const row of result) {
    row.throughputRatioToOneWorker = row.actualNodesPerSecond / result[0].actualNodesPerSecond;
    row.meanSearchLatencyRatioToOneWorker = row.searchCallLatencyNs.mean / result[0].searchCallLatencyNs.mean;
  }
  return result;
}

export async function readBound(filePath, record) {
  const bytes = await fs.readFile(filePath);
  requireThat(record && sha256(bytes) === record.sha256 && bytes.length === record.bytes,
    `authenticated bytes changed: ${filePath}`);
  return bytes;
}

function relative(root, name) {
  requireThat(typeof name === 'string' && name && !path.isAbsolute(name) &&
    !name.split(/[\\/]/).includes('..'), 'unsafe relative inventory path');
  return path.join(root, name);
}

async function frozenWrite(root, name, bytes) {
  const destination = relative(root, name);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, bytes, { flag: 'wx', mode: 0o444 });
  return { path: name, bytes: bytes.length, sha256: sha256(bytes) };
}

async function readJsonHash(filePath, expectedHash) {
  const bytes = await fs.readFile(filePath);
  requireThat(sha256(bytes) === expectedHash, `input hash mismatch: ${filePath}`);
  return { bytes, value: JSON.parse(bytes) };
}

export function parseCpuList(text) {
  requireThat(typeof text === 'string' && /^[0-9,-]+$/.test(text.trim()), 'unavailable CPU affinity');
  const result = [];
  for (const part of text.trim().split(',')) {
    requireThat(/^[0-9]+(?:-[0-9]+)?$/.test(part), 'invalid CPU affinity range');
    const pieces = part.split('-').map(Number), lo = pieces[0], hi = pieces[1] ?? lo;
    requireThat(pieces.length <= 2 && safeInteger(lo) && safeInteger(hi) && hi >= lo && hi - lo <= 8192,
      'invalid CPU affinity range');
    for (let cpu = lo; cpu <= hi; ++cpu) result.push(cpu);
  }
  requireThat(new Set(result).size === result.length, 'overlapping CPU affinity');
  return result.sort((a, b) => a - b);
}

async function affinity() {
  const status = await fs.readFile('/proc/self/status', 'utf8');
  return parseCpuList(status.match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1]);
}

async function optionalText(filePath) {
  try { return await fs.readFile(filePath, 'utf8'); }
  catch (error) { if (['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) return null; throw error; }
}

async function environment() {
  const [cpuInfo, procCgroup, mounts, cpuMax, cpuStat, cpuPressure, allowed] = await Promise.all([
    optionalText('/proc/cpuinfo'), optionalText('/proc/self/cgroup'), optionalText('/proc/self/mountinfo'),
    optionalText('/sys/fs/cgroup/cpu.max'), optionalText('/sys/fs/cgroup/cpu.stat'),
    optionalText('/sys/fs/cgroup/cpu.pressure'), affinity(),
  ]);
  return { timestamp: new Date().toISOString(), platform: process.platform, architecture: process.arch,
    release: os.release(), nodeVersion: process.version, v8Version: process.versions.v8,
    affinity: allowed, cpuModel: cpuInfo?.match(/^model name\s*:\s*(.+)$/m)?.[1] ?? null,
    procCgroup, cgroupMountLines: mounts?.split('\n').filter(line => / - cgroup2? /.test(line)) ?? null,
    cpuMax, cpuStat, cpuPressure,
    quotaObservation: 'Missing cgroup files do not establish an unlimited CPU quota; affinity is not a CPU-time entitlement.' };
}

async function handleHash(handle) {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) { hash.update(chunk); bytes += chunk.length; }
  return { bytes, sha256: hash.digest('hex') };
}

export async function retainExecutable(filePath, expected = null) {
  // Open the supplied path first: /proc/self/exe then names the running inode,
  // even if its former pathname has been replaced. realpath is display metadata.
  const handle = await fs.open(filePath, 'r');
  try {
    const actual = await handleHash(handle);
    if (expected) requireThat(actual.bytes === expected.bytes && actual.sha256 === expected.sha256,
      `executable changed: ${filePath}`);
    return { handle, record: { path: await fs.realpath(filePath), ...actual } };
  } catch (error) { await handle.close(); throw error; }
}

export function spawnVerifiedNode({ taskset, node, script, flags, cpu, args }) {
  // Child descriptors 3/4/6 retain the verified taskset/Node/script inodes.
  // fd 5 is the Node IPC channel, preserved across taskset's exec.
  return spawn('/proc/self/fd/3', ['-c', String(cpu), '/proc/self/fd/4', ...flags,
    '/proc/self/fd/6', ...args], {
    stdio: ['ignore', 'pipe', 'pipe', taskset.handle.fd, node.handle.fd, 'ipc', script.fd],
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
  });
}

async function readonlyTree(root) {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) await readonlyTree(path.join(root, entry.name));
  }
  await fs.chmod(root, 0o555);
}

export async function prepare(configPath, costRegistrationPath, costResultsPath, costAuditPath, output) {
  const configBytes = await fs.readFile(configPath), config = validateConfig(JSON.parse(configBytes));
  const [registration, results, audit] = await Promise.all([
    readJsonHash(costRegistrationPath, config.costRegistrationSha256),
    readJsonHash(costResultsPath, config.costResultsSha256), readJsonHash(costAuditPath, config.costAuditSha256),
  ]);
  const cost = registration.value, report = results.value;
  requireThat(cost.schema === 'chessy.sparse-v2-cost-registration.v1' &&
    report.schema === 'chessy.sparse-v2-cost-results.v1' && report.status === 'complete-research-only' &&
    report.allExactSignaturesMatch === true && report.productionAdmission === false &&
    report.gameOutcomesUsed === false && report.registrationSha256 === config.costRegistrationSha256,
  'cost study is not an eligible completed research input');
  requireThat(audit.value.schema === 'chessy.sparse-v2-cost-independent-audit.v1' && audit.value.status === 'pass' &&
    audit.value.registrationSha256 === config.costRegistrationSha256 && audit.value.resultsSha256 === config.costResultsSha256,
  'independent cost audit does not bind these results');
  requireThat(identical(cost.config.nodeFlags, config.nodeFlags) &&
    identical(cost.config.warmupFens, config.warmupFens) && cost.config.searchWarmupCycles === config.searchWarmupCycles &&
    cost.config.searchWarmupNodes === config.searchWarmupNodes && cost.config.maximumDepth === config.maximumDepth,
  'parallel and cost search/warmup contracts differ');
  const { target, variant } = report.runtimeSelection;
  requireThat(['wasm-scalar', 'wasm-simd'].includes(target) && ['compact', 'fused', 'cached'].includes(variant),
    'selected runtime is not WASM');
  const selection = { target, variant, model: 'full' }, base = path.dirname(costRegistrationPath);
  const binaryName = cost.binaries[`${target}-narrow`];
  const sourceNames = { 'module.wasm': binaryName, 'full.i16le': 'models/full.i16le',
    'rules.js': 'rules.js', 'wasm_runner.mjs': 'source/tools/sparse_eval_v2/wasm_runner.mjs', 'roots.json': 'roots.json' };
  const retained = {};
  for (const [destination, source] of Object.entries(sourceNames)) {
    retained[destination] = await readBound(relative(base, source), cost.files[source]);
  }
  requireThat(sha256(retained['full.i16le']) === config.fullWeightsSha256, 'full weights changed');
  const search = await readBound(relative(path.dirname(costResultsPath), report.searchObservations.path), report.searchObservations);
  const rows = search.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line));
  requireThat(rows.length === report.fullSearchObservations + report.pruningSearchObservations, 'cost row inventory mismatch');
  const roots = JSON.parse(retained['roots.json']), expected = makeExpected(rows, roots, selection, config);
  const env = await environment();
  requireThat(process.platform === 'linux' && env.affinity.length >= 5, 'this study requires Linux and five available CPU affinity slots');
  const [node, taskset] = await Promise.all([retainExecutable(cost.node.path, cost.node), retainExecutable('/usr/bin/taskset')]);
  try {
    await fs.mkdir(output, { recursive: false });
    const files = {};
    retained['parallel.mjs'] = await fs.readFile(SELF);
    retained['config.json'] = configBytes;
    retained['expected-signatures.json'] = encode(expected);
    retained['cost-registration.json'] = registration.bytes;
    retained['cost-results.json'] = results.bytes;
    retained['cost-audit.json'] = audit.bytes;
    retained['cost-search.jsonl'] = search;
    for (const [name, bytes] of Object.entries(retained)) files[name] = await frozenWrite(output, name, bytes);
    for (const record of Object.values(files)) await readBound(relative(output, record.path), record);
    const manifest = { schema: REGISTRATION_SCHEMA, status: 'frozen-before-observations', researchOnly: true,
      productionAdmission: false, config, selection, files, environment: env,
      workerCpus: env.affinity.slice(0, 4), coordinatorCpu: env.affinity.at(-1),
      node: { ...node.record, version: cost.node.version }, taskset: taskset.record,
      expectedJobsPerWorkerCount: config.roots * config.replicates,
      measuredBlockOrder: planBlocks(config), gameOutcomesRead: false, teacherLabelsRead: false };
    const record = await frozenWrite(output, 'manifest.json', encode(manifest));
    await readonlyTree(output);
    return { manifest: path.join(output, record.path), ...record, selection };
  } finally { await Promise.allSettled([node.handle.close(), taskset.handle.close()]); }
}

async function registrationInput(manifestPath, manifestHash, runtimeOnly = false) {
  const retained = await readJsonHash(manifestPath, manifestHash), manifest = retained.value;
  requireThat(manifest.schema === REGISTRATION_SCHEMA && manifest.status === 'frozen-before-observations' &&
    manifest.researchOnly === true && manifest.productionAdmission === false, 'invalid parallel registration');
  validateConfig(manifest.config);
  const directory = path.dirname(manifestPath);
  requireThat(sha256(await fs.readFile(SELF)) === manifest.files['parallel.mjs'].sha256, 'executing source is not frozen source');
  const files = {};
  const runtimeNames = new Set(['parallel.mjs', 'config.json', 'module.wasm', 'full.i16le',
    'rules.js', 'wasm_runner.mjs', 'roots.json', 'expected-signatures.json']);
  for (const [name, record] of Object.entries(manifest.files)) {
    if (!runtimeOnly || runtimeNames.has(name)) files[name] = await readBound(relative(directory, name), record);
  }
  requireThat(identical(JSON.parse(files['config.json']), manifest.config), 'configuration mirror differs');
  return { manifest, directory, files, roots: JSON.parse(files['roots.json']), expected: JSON.parse(files['expected-signatures.json']) };
}

function send(message) {
  return new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()));
}

async function worker(manifestPath, manifestHash, workersText, replicateText, workerText, cpuText) {
  requireThat(typeof process.send === 'function', 'worker requires inherited IPC');
  const started = process.hrtime.bigint();
  // The coordinator authenticates the complete cost evidence. Workers consume
  // only the registered runtime inputs, avoiding copies of the 5 MB cost log.
  const { manifest, directory, files, roots, expected } = await registrationInput(manifestPath, manifestHash, true);
  const config = manifest.config, workers = boundedInteger(workersText, 'workers', 1, 4);
  const replicate = boundedInteger(replicateText, 'replicate', 0, 2), workerId = boundedInteger(workerText, 'worker', 0, workers - 1);
  const cpu = boundedInteger(cpuText, 'CPU', 0, 8192);
  requireThat(config.workerCounts.includes(workers) && cpu === manifest.workerCpus[workerId] &&
    identical(await affinity(), [cpu]) && identical(process.execArgv, config.nodeFlags), 'worker affinity/flags mismatch');
  // Import the exact verified host bytes. It has no non-built-in imports.
  const { WasmEvaluator } = await import('data:text/javascript;base64,' + files['wasm_runner.mjs'].toString('base64'));
  const engine = await WasmEvaluator.open(path.join(directory, 'module.wasm'), path.join(directory, 'full.i16le'),
    manifest.selection.variant, path.join(directory, 'rules.js'));
  const info = engine.info();
  for (const [key, filename] of Object.entries({ moduleSha256: 'module.wasm', weightsSha256: 'full.i16le', rulesSha256: 'rules.js' })) {
    requireThat(info[key] === manifest.files[filename].sha256, `worker ${key} differs`);
  }
  requireThat(info.nodeVersion === manifest.node.version && info.variant === manifest.selection.variant &&
    info.simdCompiled === (manifest.selection.target === 'wasm-simd') && identical(info.nodeArguments, config.nodeFlags),
  'worker runtime identity mismatch');
  const warmupResults = [], warmupStarted = process.hrtime.bigint();
  engine.loadPositions(config.warmupFens);
  for (let cycle = 0; cycle < config.searchWarmupCycles; ++cycle) {
    for (let index = 0; index < config.warmupFens.length; ++index) {
      for (const code of [0, engine.variant]) {
        engine.loadHistory([]);
        warmupResults.push({ cycle, index, mode: code === 0 ? 'hce' : 'candidate',
          ...engine.search({ index, variant: code, nodes: config.searchWarmupNodes, depth: config.maximumDepth }) });
      }
    }
  }
  const warmupElapsedNs = Number(process.hrtime.bigint() - warmupStarted);
  engine.loadPositions(roots.map(root => root.fen));
  const jobs = planJobs(roots, workers, replicate).filter(job => job.worker === workerId);
  const memoryReady = process.memoryUsage();
  const ready = { kind: 'ready', worker: workerId, workers, replicate, cpu, info, memoryReady,
    warmupResults, warmupRequests: warmupResults.length, warmupElapsedNs,
    startupAndWarmupElapsedNs: Number(process.hrtime.bigint() - started) };
  const go = new Promise((resolve, reject) => {
    process.once('message', message => message?.kind === 'go' ? resolve() : reject(new Error('invalid worker start barrier')));
    process.once('disconnect', () => reject(new Error('coordinator disconnected before start')));
  });
  await send(ready);
  await go;
  const cpuStart = process.cpuUsage(), blockStart = process.hrtime.bigint(), rows = [];
  for (const job of jobs) {
    engine.loadHistory([]);
    const result = engine.search({ index: job.index, nodes: config.nodes, depth: config.maximumDepth });
    requireThat(identical(signature(result), expected[job.root]), `worker signature mismatch: ${job.root}`);
    rows.push({ ...job, requested_nodes: config.nodes, ...result });
  }
  const workerComputeElapsedNs = Number(process.hrtime.bigint() - blockStart), cpuUsage = process.cpuUsage(cpuStart);
  await send({ kind: 'done', worker: workerId, workers, replicate, rows, workerComputeElapsedNs,
    cpuUsage, memoryEnd: process.memoryUsage(), resources: process.resourceUsage() });
  process.disconnect();
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // A worker can fail during another worker's startup. Awaiters still see this rejection.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function monitor(child, workerId) {
  const ready = deferred(), done = deferred(), exit = deferred();
  let readyValue = null, doneValue = null, stdout = '', stderr = '';
  const fail = error => { ready.reject(error); done.reject(error); exit.reject(error); };
  child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 65536) { fail(new Error('unexpected worker stdout')); child.kill(); } });
  child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 65536) { fail(new Error('excessive worker stderr')); child.kill(); } });
  child.on('error', fail);
  child.on('message', message => {
    if (message?.kind === 'ready' && !readyValue && message.worker === workerId) { readyValue = message; ready.resolve(message); }
    else if (message?.kind === 'done' && readyValue && !doneValue && message.worker === workerId) { doneValue = message; done.resolve(message); }
    else fail(new Error(`invalid worker ${workerId} IPC message`));
  });
  child.once('close', (code, signal) => {
    if (code !== 0 || signal || !readyValue || !doneValue || stdout || stderr) {
      fail(new Error(`worker ${workerId} failed: ${code}/${signal}; ${stderr.slice(-4096)}`));
    } else exit.resolve({ code, signal });
  });
  return { child, ready: ready.promise, done: done.promise, exit: exit.promise,
    evidence: () => ({ worker: workerId, ready: readyValue, done: doneValue, stdout, stderr }), fail };
}

async function pinCoordinator(taskset, cpu) {
  await new Promise((resolve, reject) => {
    const child = spawn('/proc/self/fd/3', ['-pc', String(cpu), String(process.pid)], {
      stdio: ['ignore', 'pipe', 'pipe', taskset.handle.fd],
    });
    let stderr = '';
    child.stdout.resume(); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`coordinator affinity failed: ${stderr}`)));
  });
  requireThat(identical(await affinity(), [cpu]), 'coordinator was not pinned');
}

async function runBlock(context, spec, output, ordinal) {
  const { manifest, manifestPath, manifestHash, node, taskset, script, roots, expected } = context;
  const clients = [], launchStarted = process.hrtime.bigint();
  let timer;
  try {
    for (let workerId = 0; workerId < spec.workers; ++workerId) {
      const child = spawnVerifiedNode({ node, taskset, script, flags: manifest.config.nodeFlags,
        cpu: manifest.workerCpus[workerId], args: ['worker', manifestPath, manifestHash,
          String(spec.workers), String(spec.replicate), String(workerId), String(manifest.workerCpus[workerId])] });
      clients.push(monitor(child, workerId));
    }
    timer = setTimeout(() => {
      for (const client of clients) { client.fail(new Error('parallel block timed out')); client.child.kill('SIGKILL'); }
    }, manifest.config.blockTimeoutMs);
    const ready = await Promise.all(clients.map(client => client.ready));
    for (const item of ready) requireThat(item.workers === spec.workers && item.replicate === spec.replicate &&
      item.warmupRequests === 32 && item.cpu === manifest.workerCpus[item.worker], 'worker ready inventory mismatch');
    const preparationElapsedNs = Number(process.hrtime.bigint() - launchStarted);
    const start = process.hrtime.bigint();
    for (const client of clients) client.child.send({ kind: 'go' });
    const done = await Promise.all(clients.map(client => client.done));
    const wallElapsedNs = Number(process.hrtime.bigint() - start);
    await Promise.all(clients.map(client => client.exit));
    const block = { ordinal, ...spec, wallElapsedNs, preparationElapsedNs,
      workerResults: done.map((item, index) => ({ ...item, ...ready[index], kind: 'worker-result', rows: undefined })),
      rows: done.flatMap(item => item.rows).sort((a, b) => a.ordinal - b.ordinal),
      aggregateTimer: 'Coordinator before GO broadcast through receipt of every DONE message; includes dispatch, IPC, serialization and scheduling, excludes startup, parsing and warmup.' };
    validateBlock(block, roots, expected, manifest.config);
    await frozenWrite(output, `block-${String(ordinal).padStart(2, '0')}.json`, encode(block));
    return block;
  } catch (error) {
    for (const client of clients) if (client.child.exitCode === null) client.child.kill('SIGKILL');
    await frozenWrite(output, `block-${String(ordinal).padStart(2, '0')}-failure.json`,
      encode({ spec, error: String(error.stack || error), workers: clients.map(client => client.evidence()) }));
    throw error;
  } finally { if (timer) clearTimeout(timer); }
}

export async function run(manifestPath, manifestHash, output) {
  const input = await registrationInput(manifestPath, manifestHash), { manifest } = input;
  const before = await environment();
  requireThat(manifest.workerCpus.every(cpu => before.affinity.includes(cpu)) &&
    before.affinity.includes(manifest.coordinatorCpu), 'registered CPU affinity is unavailable');
  const node = await retainExecutable(manifest.node.path, manifest.node);
  let taskset, script;
  try {
    taskset = await retainExecutable(manifest.taskset.path, manifest.taskset);
    script = await fs.open(SELF, 'r');
    requireThat((await handleHash(script)).sha256 === manifest.files['parallel.mjs'].sha256, 'script inode differs');
    const runningNode = await retainExecutable('/proc/self/exe', manifest.node);
    await runningNode.handle.close();
    await fs.mkdir(output, { recursive: false });
    await frozenWrite(output, 'plan.json', encode({ schema: 'chessy.sparse-v2-parallel-execution.v1',
      status: 'running', registrationSha256: manifestHash, registeredImplementationSha256: manifest.files['parallel.mjs'].sha256,
      selection: manifest.selection, config: manifest.config, environmentBefore: before,
      workerCpus: manifest.workerCpus, coordinatorCpu: manifest.coordinatorCpu,
      blockOrder: planBlocks(manifest.config), noRetries: true, noGameOutcomesRead: true }));
    await pinCoordinator(taskset, manifest.coordinatorCpu);
    const blocks = [], context = { ...input, manifestPath, manifestHash, node, taskset, script };
    try {
      for (const [ordinal, spec] of planBlocks(manifest.config).entries()) {
        blocks.push(await runBlock(context, spec, output, ordinal));
        process.stdout.write(JSON.stringify({ completedBlock: ordinal + 1, totalBlocks: 9, ...spec }) + '\n');
      }
      // Recheck retained executable inodes and every snapshot before publishing completion.
      for (const executable of [node, taskset]) requireThat(identical(await handleHash(executable.handle),
        { bytes: executable.record.bytes, sha256: executable.record.sha256 }), 'retained executable changed during run');
      await registrationInput(manifestPath, manifestHash);
      const inventory = {};
      for (let ordinal = 0; ordinal < blocks.length; ++ordinal) {
        const name = `block-${String(ordinal).padStart(2, '0')}.json`, bytes = await fs.readFile(path.join(output, name));
        inventory[name] = { path: name, bytes: bytes.length, sha256: sha256(bytes) };
      }
      const observations = Buffer.concat(blocks.flatMap(block => block.rows.map(row => Buffer.from(JSON.stringify(row) + '\n'))));
      inventory['search.jsonl'] = await frozenWrite(output, 'search.jsonl', observations);
      const results = { schema: RESULTS_SCHEMA, status: 'complete-research-only', researchOnly: true,
        productionAdmission: false, registrationSha256: manifestHash, selection: manifest.selection,
        allExactSignaturesMatch: true, searchObservations: blocks.reduce((sum, block) => sum + block.rows.length, 0),
        fixedJobsPerWorkerCount: manifest.expectedJobsPerWorkerCount, distinctRoots: manifest.config.roots,
        independentProcessCounts: manifest.config.workerCounts, summary: summarize(blocks, manifest.config), inventory,
        environmentBefore: before, environmentAfter: await environment(),
        workerCpus: manifest.workerCpus, coordinatorCpu: manifest.coordinatorCpu,
        limitations: [
          'Independent searches in separate Node/WASM processes; no parallelism inside one search tree.',
          'Seventy-two development cost roots repeated three times; not 216 independent positions and not playing-strength evidence.',
          'One complete nine-block campaign on one host; no selective retries or confidence interval claim.',
          'Batch wall time includes dispatch, IPC, serialization and scheduling. Per-search latency times the synchronous WASM call.',
          'Worker peak RSS is process-lifetime Linux maxRSS including warmup. Sums of worker peaks are upper bounds, not simultaneous sampled resident memory; coordinator memory is excluded.',
          'Each worker has a separate fixed WASM memory; coefficient payload is only part of its process memory.',
          'CPU affinity does not establish quota. Unexposed cgroup quota/throttling remain unknown.',
        ], gameOutcomesRead: false, teacherLabelsRead: false };
      const receipt = await frozenWrite(output, 'results.json', encode(results));
      await readonlyTree(output);
      return { path: path.join(output, 'results.json'), sha256: receipt.sha256, summary: results.summary };
    } catch (error) {
      await frozenWrite(output, 'failure.json', encode({ status: 'failed-no-retry', registrationSha256: manifestHash,
        completedBlocks: blocks.length, error: String(error.stack || error) }));
      throw error;
    }
  } finally { await Promise.allSettled([node.handle.close(), taskset?.handle.close(), script?.close()]); }
}

async function main(args) {
  const [command, ...rest] = args;
  if (command === 'prepare' && rest.length === 5) process.stdout.write(JSON.stringify(await prepare(...rest)) + '\n');
  else if (command === 'run' && rest.length === 3) process.stdout.write(JSON.stringify(await run(...rest)) + '\n');
  else if (command === 'worker' && rest.length === 6) await worker(...rest);
  else throw new Error('usage: parallel.mjs prepare config.json cost-registration.json cost-results.json cost-audit.json new-directory | run manifest.json expected-manifest-sha256 new-directory');
}

let entryPath = null;
if (process.argv[1]) { try { entryPath = await fs.realpath(process.argv[1]); } catch { /* Imported by tests. */ } }
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  try { await main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1; }
}
