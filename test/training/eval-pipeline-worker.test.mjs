#!/usr/bin/env node
// Candidate modules through the unmodified production Play Worker.
// Usage: node test/training/eval-pipeline-worker.test.mjs --browser chromium|webkit BUILD_DIR RECEIPT.json
// Playwright follows test/browser/helper.js resolution; CHROMIUM_PATH is optional.
// Only correctness is gated. Cold/warm timings are retained descriptive probes.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arguments_ = process.argv.slice(2);
let browserName = process.env.BROWSER || 'chromium';
if (arguments_[0] === '--browser') browserName = arguments_.splice(0, 2)[1];
assert.ok(['chromium', 'webkit'].includes(browserName), 'browser must be chromium or webkit');
assert.equal(arguments_.length, 2,
  'usage: node test/training/eval-pipeline-worker.test.mjs --browser chromium|webkit BUILD_DIR RECEIPT.json');
const directory = fs.realpathSync(arguments_[0]), output = path.resolve(arguments_[1]);
assert.ok(!fs.existsSync(output), 'receipt already exists; replacement is forbidden');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sourceBytes = fs.readFileSync(fileURLToPath(import.meta.url));
const preparedBytes = fs.readFileSync(path.join(directory, 'PREPARED.json'));
const builtBytes = fs.readFileSync(path.join(directory, 'BUILT.json'));
const prepared = JSON.parse(preparedBytes), built = JSON.parse(builtBytes);
const variants = ['baseline', 'baseline-memory', 'hce-scalar', 'hce-simd', 'sparse-scalar', 'sparse-simd'];
assert.equal(built.schema, 'chessy.eval-pipeline-build.v1');
assert.equal(built.controlReproducedExactly, true);
assert.equal(built.preparedSha256, digest(preparedBytes));
assert.match(built.baseCommit, /^[0-9a-f]{40}$/);
assert.deepEqual(Object.keys(built.modules).sort(), variants.slice().sort());
assert.deepEqual(prepared.variants, variants);

function retained(name, binding = prepared.files[name]) {
  assert.ok(binding, 'missing retained identity: ' + name);
  const filename = path.resolve(directory, name);
  assert.ok(filename.startsWith(directory + path.sep), 'retained path escapes build');
  assert.equal(fs.realpathSync(filename), filename, 'retained source must not be a symlink');
  const bytes = fs.readFileSync(filename);
  assert.equal(bytes.byteLength, binding.bytes, name + ' byte length');
  assert.equal(digest(bytes), binding.sha256, name + ' digest');
  return bytes;
}

// The preparation manifest already retains these exact base runtime bytes.
// Capture the Worker from that same commit; do not substitute a modified shim.
const loaderBytes = retained('runtime/wasm-engine.js');
const rulesBytes = retained('runtime/engine.js');
const workerBytes = execFileSync('git', ['show', built.baseCommit + ':assets/ai-worker.js'], { cwd: root });
const releaseBytes = execFileSync('git', ['show', built.baseCommit + ':sw.js'], { cwd: root });
const release = /const RELEASE = ['"](r\d+)['"]/.exec(releaseBytes.toString())?.[1];
assert.ok(release, 'base release identity is required');
const modules = Object.fromEntries(variants.map(name => [name, retained(built.modules[name].path, built.modules[name])]));

// Execute precisely the captured loader/rules bytes for the Node oracle.
vm.runInThisContext(rulesBytes.toString(), { filename: 'captured-production-rules.js' });
const shim = { exports: {} };
vm.compileFunction(loaderBytes.toString(), ['module', 'exports'],
  { filename: 'captured-production-loader.js' })(shim, shim.exports);
const Loader = shim.exports, Chess = globalThis.Chess;
assert.equal(Loader.ABI_VERSION, 2);
const uci = move => move && (Chess.sqName(move.from) + Chess.sqName(move.to) + (move.promotion || '').toLowerCase());
function replay(tokens) {
  let state = Chess.newGameState();
  const historyFens = [Chess.toFen(state)];
  for (const token of tokens) {
    assert.equal(Chess.gameStatus(state).over, false, 'fixture continues a terminal position');
    const move = Chess.legalMoves(state).find(candidate => uci(candidate) === token);
    assert.ok(move, 'illegal full-prefix fixture: ' + token);
    state = Chess.playMove(state, move);
    historyFens.push(Chess.toFen(state));
  }
  return { fen: Chess.toFen(state), positions: state.positions, historyFens, prefixUci: tokens };
}
const start = replay([]);
const opening = replay(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6', 'b5a4', 'g8f6', 'e1g1', 'f8e7']);
const repetition = replay(['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8']);
assert.equal(repetition.positions[Chess.positionKey(Chess.parseFen(repetition.fen))], 3);
const tieFen = '7k/5Q2/6K1/8/8/8/8/8 w - - 0 1';

function request(id, fixture, extra = {}) {
  return { id, fen: fixture.fen, positions: fixture.positions, maxDepth: 30,
    nodeLimit: 2000, timeMs: 0, quiesce: true, rootSeed: 0, ...extra };
}
function signature(response) {
  const { id, elapsedMs, engine, ...result } = response;
  return result;
}
function verifySuccess(observation, expected, label) {
  const response = observation.response;
  assert.equal(response.id, observation.request.id, label + ' response identity');
  assert.equal(response.engine, 'wasm', label + ' no fallback engine');
  assert.equal(Object.hasOwn(response, 'error'), false, label + ' successful search');
  assert.ok(Number.isInteger(response.elapsedMs) && response.elapsedMs >= 0, label + ' worker search duration');
  assert.ok(Number.isFinite(observation.wallMs) && observation.wallMs >= 0, label + ' request wall duration');
  assert.deepEqual(signature(response), expected, label + ' exact Node signature');
  if (response.move) {
    const legal = Chess.legalMoves(Chess.parseFen(observation.request.fen)).map(uci);
    assert.ok(legal.includes(uci(response.move)), label + ' production-rules legal move');
    assert.deepEqual(observation.legalUcis, legal.sort(), label + ' browser rules agree');
  }
}
function verifyFailure(observation, kind) {
  assert.deepEqual(observation.response, { id: observation.request.id, error: kind }, 'structured failure without substitute result');
}

const resources = new Map([
  ['/blank', { type: 'text/html', bytes: Buffer.from('<!doctype html><meta charset="utf-8"><title>Worker contract</title><link rel="icon" href="data:,">' +
    '<script src="/assets/engine.js?r=' + release + '"></script>') }],
  ['/assets/ai-worker.js', { type: 'text/javascript', bytes: workerBytes }],
  ['/assets/wasm-engine.js', { type: 'text/javascript', bytes: loaderBytes }],
  ['/assets/engine.js', { type: 'text/javascript', bytes: rulesBytes }],
  ['/invalid.wasm', { type: 'application/wasm', bytes: Buffer.from('deliberately-invalid-wasm') }],
  ...variants.map(name => ['/modules/' + name + '.wasm', { type: 'application/wasm', bytes: modules[name] }])
]);
const requests = [];
const server = http.createServer((incoming, response) => {
  const url = new URL(incoming.url, 'http://127.0.0.1');
  const resource = resources.get(url.pathname);
  const status = resource ? 200 : 404;
  const bytes = resource?.bytes || Buffer.from('missing');
  requests.push({ url: url.pathname + url.search, status, bytes: bytes.length, sha256: digest(bytes) });
  response.writeHead(status, { 'Content-Type': resource?.type || 'text/plain', 'Cache-Control': 'no-store' });
  response.end(bytes);
});
let pw, packageName;
try { packageName = 'playwright'; pw = require(packageName); }
catch { packageName = 'playwright-core'; pw = require(packageName); }
const launchOptions = { headless: true };
if (browserName === 'chromium' && process.env.CHROMIUM_PATH) launchOptions.executablePath = process.env.CHROMIUM_PATH;
let browser;
const observations = [], nodeResults = {}, browserResults = {}, failures = [], pageErrors = [], consoleErrors = [];
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await pw[browserName].launch(launchOptions);
  const page = await browser.newPage();
  page.on('pageerror', error => pageErrors.push(String(error)));
  page.on('console', event => { if (event.type() === 'error') consoleErrors.push(event.text()); });
  await page.goto(origin + '/blank');
  assert.deepEqual(await page.evaluate(() => ({ rules: typeof Chess, loader: typeof WasmEngine, fallback: typeof ChessAI })),
    { rules: 'object', loader: 'undefined', fallback: 'undefined' }, 'main thread has rules only');
  async function workerProbe(probe, batches) {
    return page.evaluate(async ({ workerUrl, batches }) => {
      const worker = new Worker(workerUrl), observations = [];
      const created = performance.now();
      let pending = null;
      worker.onerror = event => pending?.reject(new Error('unexpected Worker error: ' + event.message));
      worker.onmessage = event => {
        try {
          if (!pending) throw new Error('unsolicited Worker response');
          const next = pending.requests[pending.responses.length];
          if (!next || event.data.id !== next.id) throw new Error('reordered or mismatched Worker response');
          const now = performance.now();
          const legalUcis = event.data.move ? Chess.legalMoves(Chess.parseFen(next.fen))
            .map(move => Chess.sqName(move.from) + Chess.sqName(move.to) + (move.promotion || '').toLowerCase()).sort() : null;
          pending.responses.push({ request: next, response: event.data,
            wallMs: now - pending.started[pending.responses.length], workerAgeMs: now - created, legalUcis });
          if (pending.responses.length === pending.requests.length) pending.resolve(pending.responses);
        } catch (error) { pending?.reject(error); }
      };
      try {
        for (const batch of batches) {
          const results = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Worker correctness request timed out')), 15000);
            pending = { requests: batch, responses: [], started: [],
              resolve: value => { clearTimeout(timer); resolve(value); },
              reject: error => { clearTimeout(timer); reject(error); } };
            for (const request of batch) {
              pending.started.push(performance.now());
              worker.postMessage(request);
            }
          });
          observations.push(...results);
          pending = null;
        }
        return observations;
      } finally { worker.terminate(); }
    }, { workerUrl: '/assets/ai-worker.js?r=' + release + '&probe=' + probe, batches });
  }

  for (const name of variants) {
    const moduleUrl = '/modules/' + name + '.wasm?r=' + release + '&probe=' + name;
    const wrongUrl = '/must-not-fetch-after-warm-' + name + '.wasm';
    const options = { wasmUrl: moduleUrl };
    const cold = request(name + '-cold', start, options);
    const queued = request(name + '-queued-seed', start, { ...options, rootSeed: 0xC0FFEE });
    const cases = [cold, queued,
      request(name + '-warm', start, options),
      request(name + '-full-prefix', opening, options),
      request(name + '-threefold', repetition, options),
      request(name + '-history-cleared', repetition, { ...options, positions: {} }),
      request(name + '-invalid-fen', start, { ...options, fen: 'not a FEN' }),
      request(name + '-after-error', start, options),
      request(name + '-singleton', start, { wasmUrl: wrongUrl }),
      ...Array.from({ length: 8 }, (_, seed) => request(name + '-mate-tie-' + seed,
        { fen: tieFen, positions: {} }, { ...options, rootSeed: seed, maxDepth: 2, quiesce: false }))];
    const oracle = Loader.loadSync(modules[name]);
    nodeResults[name] = cases.map(item => {
      if (item.id.endsWith('-invalid-fen')) {
        assert.throws(() => oracle.search(item.fen, item));
        return null;
      }
      return oracle.search(item.fen, item);
    });
    const rows = await workerProbe(name, [[cold, queued], ...cases.slice(2).map(item => [item])]);
    assert.equal(rows.length, cases.length, name + ' complete request inventory');
    for (const [index, row] of rows.entries()) {
      assert.deepEqual(row.request, cases[index], name + ' unchanged request');
      if (nodeResults[name][index] === null) verifyFailure(row, 'wasm-search-error');
      else verifySuccess(row, nodeResults[name][index], row.request.id);
    }
    assert.deepEqual(signature(rows[0].response), signature(rows[2].response), name + ' warm seeded repeat');
    assert.equal(rows[4].response.stopReason, 'game-over', name + ' full prefix threefold');
    assert.equal(rows[4].response.nodes, 0, name + ' terminal history prevents search');
    assert.equal(rows[4].response.move, null);
    assert.ok(rows[5].response.nodes > 0, name + ' removing history restores search');
    const ties = new Set(rows.slice(9).map(row => uci(row.response.move)));
    assert.ok(ties.size > 1, name + ' forwarded seeds vary genuine equal best moves');
    assert.ok(rows.slice(9).every(row => row.response.score === 999999), name + ' equal mating score');
    assert.equal(requests.filter(row => row.url === moduleUrl).length, 1, name + ' singleton fetch');
    assert.equal(requests.filter(row => row.url === wrongUrl).length, 0, name + ' warm singleton retains module');
    const loaderUrl = '/assets/wasm-engine.js?r=' + release + '&probe=' + name;
    assert.equal(requests.filter(row => row.url === loaderUrl).length, 1, name + ' release forwarded to loader');
    browserResults[name] = rows.filter((_, index) => nodeResults[name][index] !== null).map(row => signature(row.response));
    observations.push({ variant: name, requests: rows,
      timing: { coldRequestWallMs: rows[0].wallMs, coldWorkerSearchMs: rows[0].response.elapsedMs,
        warmSameRequestWallMs: rows[2].wallMs, warmWorkerSearchMs: rows[2].response.elapsedMs,
        scope: 'One correctness probe; cold wall includes Worker/load/compile, warm wall includes messaging; worker elapsed covers search. No speed claim.' } });
  }
  for (const name of ['baseline-memory', 'hce-scalar', 'hce-simd']) {
    assert.deepEqual(browserResults[name], browserResults.baseline, name + ' exact HCE browser signatures');
  }
  assert.deepEqual(browserResults['sparse-simd'], browserResults['sparse-scalar'], 'exact sparse browser signatures');

  for (const [name, url] of [['fetch', '/missing.wasm'], ['compile', '/invalid.wasm']]) {
    const first = request('failed-' + name, start, { wasmUrl: url });
    const retryUrl = '/must-not-fetch-on-failed-singleton-' + name + '.wasm';
    const second = request('failed-' + name + '-sticky', start, { wasmUrl: retryUrl });
    const rows = await workerProbe('failed-' + name, [[first], [second]]);
    rows.forEach(row => verifyFailure(row, 'wasm-load-error'));
    assert.equal(requests.filter(row => row.url === url).length, 1, name + ' one failed load');
    assert.equal(requests.filter(row => row.url === retryUrl).length, 0, name + ' failed singleton is not retried silently');
    failures.push(...rows);
  }
  const missing = request('missing-url', start);
  const recovered = request('valid-after-missing-url', start,
    { wasmUrl: '/modules/baseline.wasm?r=' + release + '&probe=fresh-recovery' });
  const recovery = await workerProbe('fresh-recovery', [[missing], [recovered]]);
  verifyFailure(recovery[0], 'wasm-load-error');
  verifySuccess(recovery[1], nodeResults.baseline[0], 'queue recovers after rejected request');
  failures.push(...recovery);
  assert.deepEqual(pageErrors, [], 'no unexpected page errors');
  const executable = launchOptions.executablePath || pw[browserName].executablePath();
  const receipt = {
    schema: 'chessy.eval-pipeline-worker-check.v1', result: 'pass', researchOnly: true,
    productionAdmission: false, strengthClaim: false, timingClaim: false,
    browser: browserName, browserVersion: browser.version(), playwrightVersion: require(packageName + '/package.json').version,
    browserExecutable: { path: executable, sha256: digest(fs.readFileSync(executable)),
      scope: 'Launch entrypoint only; dependent bundle files are not individually hashed. Browser/package versions are also recorded.' },
    nodeVersion: process.version, v8Version: process.versions.v8, platform: process.platform, arch: process.arch,
    launchOptions, baseCommit: built.baseCommit, release,
    preparedSha256: digest(preparedBytes), buildSha256: digest(builtBytes), implementationSha256: digest(sourceBytes),
    sources: { worker: { sha256: digest(workerBytes), bytes: workerBytes.length, retainedText: workerBytes.toString() },
      loaderSha256: digest(loaderBytes), rulesSha256: digest(rulesBytes), releaseSourceSha256: digest(releaseBytes) },
    variants: built.modules,
    fixtures: { start, opening, repetition, tieFen }, nodeSignatures: nodeResults,
    observations, failures, httpRequests: requests,
    pageErrors, consoleErrors,
    contracts: ['production Worker bytes unchanged', 'ABI-v2 candidate and control modules', 'rules only on main thread',
      'seeded fixed-node Node/browser signatures', 'HCE and sparse exact implementation-group signatures',
      'legal moves through production rules', 'arrival order and per-request identities', 'same-worker warm reuse',
      'one module fetch per Worker', 'release query forwarding', 'full game-prefix repetition history',
      'history cleared between requests', 'equal-best-root seed variation', 'search error without fallback',
      'failed fetch/compile without fallback or silent retry', 'queue recovery after invalid request'],
    limitations: ['Small deterministic correctness probes, not performance estimates or device coverage.',
      'Headless desktop browser; mobile, service-worker release activation, UI retry and coaching checks remain separate.',
      'Cold wall includes module loading and browser compilation; warm wall and Worker elapsed use different timer scopes.']
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ result: 'pass', browser: browserName, variants: variants.length,
    successfulSearches: Object.values(browserResults).reduce((sum, values) => sum + values.length, 0) + 1,
    receipt: output, strengthClaim: false, timingClaim: false }));
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
