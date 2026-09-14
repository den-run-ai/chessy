#!/usr/bin/env node
/*
 * Real-Stockfish labels for the bounded synthetic-position HCE pilot.
 *
 * This is intentionally separate from label-stockfish.js: its generated
 * position stream is not the authenticated production selection and cannot
 * produce a release label shard.  It does reuse the production UCI parser and
 * White-POV conversion, enforces exact-CP/WDL/PV-head eligibility, and records
 * every exploratory setting in a no-replace summary.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const Data = require('./hce-synthetic-pilot-data');
const Label = require('../../test/training/label-stockfish');

const SUMMARY_SCHEMA = 'chessy.hce-synthetic-pilot-label-summary.v1';
const EXPECTED_HEX = /^[0-9a-f]{64}$/;

function sha256File(filename) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(filename, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!bytes) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function parseArgs(argv) {
  const out = {
    rows: Data.DEFAULT_ROWS,
    seed: Data.DEFAULT_SEED,
    nodes: 10000,
    hashMb: 16,
    verifyNetworks: true
  };
  const valueFlags = new Set([
    'stockfish', 'summary', 'rows', 'seed', 'nodes', 'hash-mb',
    'expected-executable-sha256', 'expected-evalfile-sha256',
    'expected-evalfile-small-sha256', 'verify-networks'
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const raw = argv[index];
    if (!raw.startsWith('--') || !valueFlags.has(raw.slice(2))) {
      throw new Error('unknown argument: ' + raw);
    }
    if (index + 1 >= argv.length) throw new Error(raw + ' requires a value');
    const value = argv[index + 1];
    const name = raw.slice(2);
    if (name === 'rows') out.rows = Number(value);
    else if (name === 'seed') out.seed = Number(value);
    else if (name === 'nodes') out.nodes = Number(value);
    else if (name === 'hash-mb') out.hashMb = Number(value);
    else if (name === 'verify-networks') {
      if (value !== 'true' && value !== 'false') {
        throw new Error('--verify-networks must be true or false');
      }
      out.verifyNetworks = value === 'true';
    } else {
      const key = name.replace(/-([a-z])/g, function (_, letter) {
        return letter.toUpperCase();
      });
      out[key] = value;
    }
  }
  if (!out.stockfish || !out.summary) {
    throw new Error('--stockfish and --summary are required');
  }
  out.stockfish = path.resolve(out.stockfish);
  out.summary = path.resolve(out.summary);
  Data.rowQuotas(out.rows);
  if (!Number.isSafeInteger(out.seed) || out.seed < 0 || out.seed > 0xffffffff) {
    throw new Error('--seed must be an integer in [0, 2^32 - 1]');
  }
  if (!Number.isSafeInteger(out.nodes) || out.nodes < 1000 || out.nodes > 1000000) {
    throw new Error('--nodes must be an integer in [1000, 1000000]');
  }
  if (!Number.isSafeInteger(out.hashMb) || out.hashMb < 1 || out.hashMb > 1024) {
    throw new Error('--hash-mb must be an integer in [1, 1024]');
  }
  for (const name of [
    'expectedExecutableSha256',
    'expectedEvalfileSha256',
    'expectedEvalfileSmallSha256'
  ]) {
    if (!EXPECTED_HEX.test(out[name] || '')) {
      throw new Error('--' + name.replace(/[A-Z]/g, function (letter) {
        return '-' + letter.toLowerCase();
      }) + ' must be SHA-256 hex');
    }
  }
  if (!fs.statSync(out.stockfish).isFile()) {
    throw new Error('--stockfish must name a file');
  }
  if (fs.existsSync(out.summary)) throw new Error('refusing to overwrite --summary');
  return out;
}

class ExploratoryUci {
  constructor(executable, workingDirectory) {
    this.child = spawn(executable, [], {
      cwd: workingDirectory,
      stdio: ['pipe', 'pipe', 'inherit']
    });
    this.lines = readline.createInterface({
      input: this.child.stdout,
      crlfDelay: Infinity
    });
    this.iterator = this.lines[Symbol.asyncIterator]();
    this.identity = [];
    this.exited = false;
    this.exit = new Promise((resolve, reject) => {
      this.child.once('error', reject);
      this.child.once('close', (code, signal) => {
        this.exited = true;
        resolve({ code, signal });
      });
    });
  }

  send(command) {
    if (this.exited || !this.child.stdin.writable) {
      throw new Error('Stockfish stdin is not writable');
    }
    this.child.stdin.write(command + '\n');
  }

  async nextLine(timeoutMs, phase) {
    let timer;
    try {
      return await Promise.race([
        this.iterator.next(),
        new Promise((_, reject) => {
          timer = setTimeout(function () {
            reject(new Error('Stockfish timeout waiting for ' + phase));
          }, timeoutMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async until(predicate, timeoutMs, phase, visitor) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Stockfish timeout waiting for ' + phase);
      const next = await this.nextLine(remaining, phase);
      if (next.done) throw new Error('Stockfish stdout closed during ' + phase);
      if (visitor) visitor(next.value);
      if (predicate(next.value)) return next.value;
    }
  }

  async initialize(hashMb) {
    this.send('uci');
    await this.until(
      function (line) { return line === 'uciok'; },
      30000,
      'uciok',
      line => { if (/^(id |option name (EvalFile|EvalFileSmall) )/.test(line)) this.identity.push(line); }
    );
    const options = [
      ['Threads', '1'],
      ['Hash', String(hashMb)],
      ['Ponder', 'false'],
      ['MultiPV', '1'],
      ['SyzygyPath', '<empty>'],
      ['UCI_LimitStrength', 'false'],
      ['UCI_ShowWDL', 'true']
    ];
    for (const option of options) {
      this.send('setoption name ' + option[0] + ' value ' + option[1]);
    }
    this.send('isready');
    await this.until(function (line) { return line === 'readyok'; }, 30000, 'readyok');
  }

  async verifyNetworks(expectedBig, expectedSmall, directory) {
    this.send('export_net pilot-big.nnue pilot-small.nnue');
    this.send('isready');
    await this.until(
      function (line) { return line === 'readyok'; },
      120000,
      'network export'
    );
    const filenames = [
      path.join(directory, 'pilot-big.nnue'),
      path.join(directory, 'pilot-small.nnue')
    ];
    const observed = filenames.map(function (filename) {
      return {
        bytes: fs.statSync(filename).size,
        sha256: sha256File(filename)
      };
    });
    if (observed[0].sha256 !== expectedBig || observed[1].sha256 !== expectedSmall) {
      throw new Error('embedded Stockfish network SHA-256 differs');
    }
    for (const filename of filenames) fs.unlinkSync(filename);
    return {
      EvalFile: observed[0],
      EvalFileSmall: observed[1]
    };
  }

  async label(fen, nodes) {
    this.send('ucinewgame');
    this.send('setoption name Clear Hash');
    this.send('isready');
    await this.until(function (line) { return line === 'readyok'; }, 30000, 'position readyok');
    this.send('position fen ' + fen + ' 0 1');
    this.send('go nodes ' + nodes);
    let latestExact = null;
    let latestEffort = null;
    let mateAfterExact = false;
    let bestMove = null;
    await this.until(
      function (line) { return /^bestmove\s/.test(line); },
      120000,
      'bestmove',
      function (line) {
        if (/^bestmove\s/.test(line)) {
          bestMove = line.split(/\s+/)[1];
          return;
        }
        const info = Label.parseInfo(line);
        if (!info) return;
        if (Number.isSafeInteger(info.nodes) && info.nodes >= 0 &&
            (!latestEffort || info.nodes >= latestEffort.nodes)) {
          latestEffort = info;
        }
        if (Number.isFinite(info.mateSideToMove)) {
          latestExact = null;
          mateAfterExact = true;
        } else if (Number.isSafeInteger(info.cpSideToMove) && !info.scoreBound) {
          latestExact = info;
          mateAfterExact = false;
        }
      }
    );
    if (mateAfterExact || !latestExact) return { eligible: false, reason: 'mate-or-missing-exact-cp' };
    if (!latestEffort || !Number.isSafeInteger(latestEffort.nodes) ||
        latestEffort.nodes < nodes) {
      return { eligible: false, reason: 'reported-nodes-under-budget' };
    }
    if (!Array.isArray(latestExact.wdlSideToMove) ||
        latestExact.wdlSideToMove.reduce(function (sum, value) { return sum + value; }, 0) !== 1000) {
      return { eligible: false, reason: 'missing-or-invalid-wdl' };
    }
    if (!Array.isArray(latestExact.pvUci) || !latestExact.pvUci.length ||
        latestExact.pvUci[0] !== bestMove) {
      return { eligible: false, reason: 'bestmove-pv-mismatch' };
    }
    const turn = fen.trim().split(/\s+/)[1];
    const pov = Label.whitePov(latestExact, turn);
    if (!pov) return { eligible: false, reason: 'invalid-white-pov' };
    return {
      eligible: true,
      teacher: {
        cpWhite: pov.cpWhite,
        wdlWhite: pov.wdlWhite,
        targetWhite: pov.targetWhite,
        bestMoveUci: bestMove,
        pvUci: latestExact.pvUci,
        depth: latestExact.depth,
        seldepth: latestExact.seldepth,
        scoreNodes: latestExact.nodes,
        reportedNodes: latestEffort.nodes
      }
    };
  }

  async quit() {
    if (!this.exited) {
      this.send('quit');
      this.child.stdin.end();
    }
    const result = await this.exit;
    if (result.code !== 0) {
      throw new Error('Stockfish exited with code ' + result.code);
    }
  }

  async abort() {
    if (!this.exited) this.child.kill('SIGKILL');
    try { await this.exit; } catch (_) {}
  }
}

async function run(options) {
  const executableSha256 = sha256File(options.stockfish);
  if (executableSha256 !== options.expectedExecutableSha256) {
    throw new Error('Stockfish executable SHA-256 differs');
  }
  const generated = Data.generate({ rows: options.rows, seed: options.seed });
  const inputHash = crypto.createHash('sha256');
  for (const row of generated.rows) inputHash.update(JSON.stringify(row) + '\n');
  const generatedInputSha256 = inputHash.digest('hex');
  const labelledHash = crypto.createHash('sha256');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'chessy-hce-pilot-sf-'));
  const started = process.hrtime.bigint();
  const exclusions = {};
  const labelledCounts = Object.fromEntries(Data.SPLITS.map(function (split) {
    return [split, Object.fromEntries(Data.PHASES.map(function (phase) {
      return [phase, 0];
    }))];
  }));
  let labelled = 0;
  let reportedNodes = 0;
  let engine = null;
  let identityLines = [];
  let networks = {
    EvalFile: { sha256: options.expectedEvalfileSha256, verified: false },
    EvalFileSmall: { sha256: options.expectedEvalfileSmallSha256, verified: false }
  };
  try {
    engine = new ExploratoryUci(options.stockfish, temporary);
    await engine.initialize(options.hashMb);
    if (options.verifyNetworks) {
      networks = await engine.verifyNetworks(
        options.expectedEvalfileSha256,
        options.expectedEvalfileSmallSha256,
        temporary
      );
      networks.EvalFile.verified = true;
      networks.EvalFileSmall.verified = true;
    }
    for (const row of generated.rows) {
      const result = await engine.label(row.fen, options.nodes);
      if (!result.eligible) {
        exclusions[result.reason] = (exclusions[result.reason] || 0) + 1;
        continue;
      }
      const output = Object.assign({}, row, { teacher: result.teacher });
      const encoded = JSON.stringify(output) + '\n';
      labelledHash.update(encoded);
      process.stdout.write(encoded);
      labelled++;
      labelledCounts[row.split][row.phase]++;
      reportedNodes += result.teacher.reportedNodes;
    }
    identityLines = engine.identity.slice();
    await engine.quit();
    engine = null;
    const elapsedSeconds = Number(process.hrtime.bigint() - started) / 1e9;
    const summary = {
      schema: SUMMARY_SCHEMA,
      status: 'research-only-synthetic-positions-real-teacher',
      fitAllowed: false,
      publishableArtifact: false,
      qualityClaimScope: 'exploratory teacher-transfer evidence only',
      generator: {
        schema: Data.SCHEMA,
        rows: options.rows,
        seed: options.seed,
        requestedCounts: generated.counts,
        familyCap: Data.FAMILY_CAP
      },
      teacher: {
        name: 'Stockfish 18',
        release: 'sf_18',
        integration: 'external-build-time-process-only',
        executableSha256,
        networks,
        identityLines,
        uci: {
          Threads: 1,
          Hash: options.hashMb,
          Ponder: false,
          MultiPV: 1,
          SyzygyPath: '<empty>',
          UCI_LimitStrength: false,
          UCI_ShowWDL: true,
          ClearHashBeforeEveryPosition: true,
          UciNewGameBeforeEveryPosition: true,
          IsReadyBeforeEveryPosition: true
        },
        search: { command: 'go nodes ' + options.nodes, nodeLimit: options.nodes },
        eligibility: {
          exactCp: true,
          wdlTotal: 1000,
          bestMoveMustMatchPvHead: true,
          mateExcluded: true
        }
      },
      output: {
        labelledRows: labelled,
        excludedRows: options.rows - labelled,
        exclusionReasons: exclusions,
        labelledCounts,
        reportedNodes,
        elapsedSeconds,
        effectiveNodesPerSecond: reportedNodes / elapsedSeconds
      },
      provenance: {
        generatedInputSha256,
        labelledStreamSha256: labelledHash.digest('hex'),
        generatorScriptSha256: sha256File(path.join(
          __dirname, 'hce-synthetic-pilot-data.js'
        )),
        labelerScriptSha256: sha256File(__filename),
        sourceCorpus: Data.metadata().corpus
      }
    };
    fs.writeFileSync(options.summary, JSON.stringify(summary) + '\n', { flag: 'wx' });
    return summary;
  } catch (error) {
    if (engine) await engine.abort();
    throw error;
  } finally {
    for (const name of ['pilot-big.nnue', 'pilot-small.nnue']) {
      try { fs.unlinkSync(path.join(temporary, name)); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    try { fs.rmdirSync(temporary); } catch (_) {}
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const summary = await run(options);
  console.error(
    'hce-synthetic-pilot-label: labelled ' + summary.output.labelledRows +
    '/' + summary.generator.rows + ' rows at ' + summary.teacher.search.nodeLimit +
    ' nodes in ' + summary.output.elapsedSeconds.toFixed(3) + 's'
  );
}

if (require.main === module) {
  main().catch(function (error) {
    console.error('hce-synthetic-pilot-label: ' + error.message);
    process.exitCode = 1;
  });
}

module.exports = { ExploratoryUci, parseArgs, run, sha256File };
