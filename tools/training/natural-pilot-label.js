#!/usr/bin/env node
/* Research-only natural-game teacher pass. Trusted isolated runner required:
 * retained input buffers and an unlinked executable inode prevent pathname
 * replacement, but are not a security seal against another same-UID process.
 * Every selected row belongs to exactly one accepted/excluded partition.
 * Failed workers are never restarted; failures invalidate the entire run.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('../../assets/engine');
const Chess = globalThis.Chess;
const Label = require('../../test/training/label-stockfish');
const Corpus = require('../../test/training/corpus');
const ROOT = path.resolve(__dirname, '../..');
const ROLES = ['shared-train', 'hce-validation', 'hce-test', 'nnue-validation', 'nnue-test'];
const IMPLEMENTATION = [__filename, 'assets/engine.js', 'test/training/label-stockfish.js',
  'test/training/corpus.js', 'test/training/prepare-lichess-evals.js', 'test/eval/e4-protocol.js']
  .map(p => path.isAbsolute(p) ? p : path.join(ROOT, p));
const HEX = /^[a-f0-9]{64}$/;
const SCHEMA = 'chessy.natural-pilot-label-summary.v1';
function check(ok, message) { if (!ok) throw new Error(message); }
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function snapshot(file, expected) {
  check(HEX.test(expected || ''), 'external SHA-256 required for ' + file);
  const fd = fs.openSync(file, 'r');
  let bytes;
  try { check(fs.fstatSync(fd).isFile(), 'input is not regular file'); bytes = fs.readFileSync(fd); }
  finally { fs.closeSync(fd); }
  check(sha256(bytes) === expected, 'snapshot digest mismatch: ' + file);
  return { file: path.resolve(file), bytes, sha256: expected };
}
function jsonSnapshot(file, expected) {
  const result = snapshot(file, expected);
  result.value = JSON.parse(result.bytes.toString('utf8'));
  return result;
}
function fileHash(file) { return sha256(fs.readFileSync(file)); }
function implementationHashes() {
  return Object.fromEntries(IMPLEMENTATION.map(file => [path.relative(ROOT, file), fileHash(file)]));
}
function moveName(m) { return Chess.sqName(m.from) + Chess.sqName(m.to) + (m.promotion || '').toLowerCase(); }
function play(state, uci) {
  check(typeof uci === 'string' && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci), 'invalid UCI move');
  const move = Chess.legalMoves(state).find(m => moveName(m) === uci);
  check(move, 'illegal UCI move ' + uci);
  // Rules-only replay needs clocks and repetition, not quadratic SAN/history
  // formatting. The legal move was independently generated above.
  const next = Chess.applyMove(state, move);
  next.positions = { ...state.positions };
  const key = Chess.positionKey(next);
  next.positions[key] = (next.positions[key] || 0) + 1;
  return next;
}
function replayRow(row) {
  check(row && row.schema === 'chessy.natural-pilot-row.v1' && HEX.test(row.id || ''), 'invalid selected row identity');
  check(ROLES.includes(row.role), 'invalid selected role');
  check(typeof row.fen === 'string' && row.fen.split(' ').length === 6, 'six-field FEN required');
  check(Array.isArray(row.prefixUci) && row.prefixUci.length > 0, 'full startpos prefix required');
  check(row.sourceGame && row.sourceGame.selectedPly === row.prefixUci.length && row.sourceId === row.sourceGame.id,
    'source-game prefix identity differs');
  let state = Chess.newGameState();
  for (const move of row.prefixUci) {
    // Historical real games may continue after an unclaimed threefold or
    // fifty-move draw. Preserve that legal history; do not substitute the
    // product's automatic claim policy for source-game rules. Current
    // endpoints are checked below, and checkmate/stalemate cannot yield a
    // legal next move.
    state = play(state, move);
  }
  check(Chess.toFen(state) === row.fen, 'replayed six-field FEN differs');
  check(row.fen4 === row.fen.split(' ').slice(0, 4).join(' '), 'FEN4 mirror differs');
  check(Corpus.clusterKey(row.fen) === row.cluster, 'position cluster differs');
  check(Corpus.positionFamilyKey(row.fen) === row.positionFamily, 'position family differs');
  check(Corpus.phaseBucket(row.fen) === row.phaseBucket, 'phase bucket differs');
  check(!Chess.gameStatus(state).over, 'selected endpoint is terminal');
  return state;
}
function teacherContract(teacher) {
  check(teacher.engine.name === 'Stockfish 18' && teacher.engine.release === 'sf_18', 'Stockfish 18 identity required');
  check(HEX.test(teacher.engine.executable.sha256), 'pinned executable digest required');
  check(teacher.search.nodeLimit === 100000 && teacher.search.command === 'go nodes 100000', '100k teacher budget required');
  for (const [key, value] of Object.entries({Threads: 1, Hash: 64, Ponder: false, MultiPV: 1,
    SyzygyPath: '<empty>', UCI_LimitStrength: false, UCI_ShowWDL: true,
    ClearHashBeforeEveryPosition: true, UciNewGameBeforeEveryPosition: true, IsReadyBeforeEveryPosition: true})) {
    check(teacher.uci[key] === value, 'frozen teacher option differs: ' + key);
  }
  const expected = [
    ['EvalFile', 'c288c895ea924429ea9092e3f36b2b3c1f00f2a3a4c759ff7e57e79e3b43e4a7', 108919594],
    ['EvalFileSmall', '37f18f62d772f3107e1d6aaca3898c130c3c86f2ab63e6555fbbca20635a899d', 3519630]
  ];
  check(teacher.engine.networks.length === 2, 'two Stockfish 18 networks required');
  expected.forEach(([option, digest, bytes], i) => {
    const n = teacher.engine.networks[i];
    check(n.option === option && n.sha256 === digest && n.bytes === bytes, 'frozen network identity differs');
  });
  const eligibility = teacher.labels.eligibility;
  check(eligibility.boundScoresAllowed === false && eligibility.reportedNodesMustMeetOrExceedLimit === true &&
    eligibility.wdlRequired === true && eligibility.wdlTotal === 1000 && eligibility.bestMoveMustMatchPvHead === true,
  'frozen label eligibility differs');
  for (const key of ['uciStartupTimeoutMs', 'readyTimeoutMs', 'positionTimeoutMs', 'quitTimeoutMs']) {
    check(Number.isSafeInteger(teacher.watchdog[key]) && teacher.watchdog[key] > 0 && teacher.watchdog[key] <= 120000,
      'invalid watchdog ' + key);
  }
  return teacher;
}
// Uses the same exact-CP parser as ExploratoryUci, with the retained-inode,
// transcript and shutdown watchdog support in the production UCI transport.
class NaturalUci extends Label.UciEngine {
  async labelNatural(row, teacher) {
    this.send('ucinewgame'); this.send('setoption name Clear Hash'); this.send('isready');
    await this.readUntil(line => line === 'readyok', this.watchdog.readyTimeoutMs, 'position readyok');
    this.send('position startpos moves ' + row.prefixUci.join(' '));
    this.send(teacher.search.command);
    let latestScore = null, latestExact = null, latestEffort = null, bestMove = null;
    const deadline = Date.now() + this.watchdog.positionTimeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) { this.forceKill(); throw new Error('Stockfish watchdog timeout waiting for bestmove'); }
      const line = await this.readUntil(line => /^info\s|^bestmove\s/.test(line), remaining, 'bestmove');
      if (/^bestmove\s/.test(line)) { bestMove = line.split(/\s+/)[1]; break; }
      const info = Label.parseInfo(line);
      if (Number.isSafeInteger(info.nodes) && info.nodes >= 0 && (!latestEffort || info.nodes >= latestEffort.nodes)) latestEffort = info;
      if (Number.isFinite(info.cpSideToMove) || Number.isFinite(info.mateSideToMove)) {
        latestScore = info;
        if (Number.isFinite(info.mateSideToMove)) latestExact = null;
        else if (!info.scoreBound) latestExact = info;
      }
    }
    return { info: latestScore && Number.isFinite(latestScore.mateSideToMove) ? latestScore : latestExact,
      terminalInfo: latestEffort || latestScore, bestMove };
  }
}
function assess(result, row, teacher, maxAbsCp, replayedState) {
  const a = Label.assessTeacherResult(result, row.fen.split(' ')[1], teacher);
  if (!a.eligible) return a;
  if (Math.abs(a.pov.cpWhite) > maxAbsCp) return { eligible: false, reason: 'outside-preregistered-cp-range' };
  let state = replayedState;
  try {
    for (const move of result.info.pvUci) {
      state = play(state, move);
    }
  } catch (error) { return { eligible: false, reason: 'illegal-pv', detail: { message: error.message } }; }
  return { eligible: true, teacher: { scoreCp: a.pov.cpWhite, wdl: a.pov.wdlWhite,
    targetWhite: a.pov.targetWhite, depth: result.info.depth, seldepth: result.info.seldepth,
    nodes: result.terminalInfo.nodes, scoreNodes: result.info.nodes,
    bestmove: result.bestMove, pv: result.info.pvUci } };
}
class Writer {
  constructor(file) {
    this.file = file; this.fd = fs.openSync(file, 'wx+');
    const stat = fs.fstatSync(this.fd);
    this.identity = { dev: stat.dev, ino: stat.ino };
    this.hash = crypto.createHash('sha256'); this.rows = 0; this.bytes = 0; this.closed = false;
    this.verifyIdentity();
  }
  integrity(message) {
    const error = new Error('artifact integrity: ' + path.basename(this.file) + ': ' + message);
    error.code = 'EARTIFACTINTEGRITY'; return error;
  }
  verifyIdentity() {
    try {
      check(!this.closed, 'writer is closed');
      const fd = fs.fstatSync(this.fd), named = fs.lstatSync(this.file);
      for (const stat of [fd, named]) {
        check(stat.isFile() && stat.dev === this.identity.dev && stat.ino === this.identity.ino,
          'retained descriptor/path inode changed');
        check(stat.size === this.bytes, 'artifact size differs from written bytes');
      }
    } catch (error) { throw this.integrity(error.message); }
  }
  append(row) {
    this.verifyIdentity();
    const bytes = Buffer.from(stable(row) + '\n'); let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(this.fd, bytes, offset, bytes.length - offset);
    this.hash.update(bytes); this.bytes += bytes.length; this.rows++;
    this.verifyIdentity();
  }
  sync() { this.verifyIdentity(); fs.fsyncSync(this.fd); this.verifyIdentity(); }
  close() {
    try {
      this.sync();
      const expected = this.hash.copy().digest('hex'), actual = crypto.createHash('sha256');
      // Authenticate bytes read through the current pathname, after proving
      // that descriptor names the retained inode. Do not certify only our
      // intended append stream when the filesystem exposes another object.
      const fd = fs.openSync(this.file, 'r'); let offset = 0;
      try {
        const stat = fs.fstatSync(fd);
        check(stat.isFile() && stat.dev === this.identity.dev && stat.ino === this.identity.ino,
          'publication read opened a different inode');
        const buffer = Buffer.allocUnsafe(1 << 20);
        for (;;) {
          const read = fs.readSync(fd, buffer, 0, buffer.length, offset);
          if (!read) break;
          actual.update(buffer.subarray(0, read)); offset += read;
        }
        this.verifyIdentity();
        check(offset === this.bytes && actual.digest('hex') === expected, 'published artifact digest differs from append stream');
      } finally { fs.closeSync(fd); }
      this.verifyIdentity();
      return { path: path.basename(this.file), sha256: expected, bytes: this.bytes, rows: this.rows };
    } catch (error) {
      throw error.code === 'EARTIFACTINTEGRITY' ? error : this.integrity(error.message);
    } finally {
      if (!this.closed) { fs.closeSync(this.fd); this.closed = true; }
    }
  }
}
function loadInputs(a) {
  const selection = jsonSnapshot(a['selection-manifest'], a['selection-manifest-sha256']);
  const rules = jsonSnapshot(a.rules, a['rules-sha256']);
  const fit = jsonSnapshot(a['fit-rules'], a['fit-rules-sha256']);
  const teacher = jsonSnapshot(a['teacher-manifest'], a['teacher-manifest-sha256']);
  const m = selection.value;
  check(m.preregistration.sha256 === rules.sha256 && m.fitPreregistration.sha256 === fit.sha256, 'selection preregistration mismatch');
  check(m.teacherContract.sha256 === teacher.sha256, 'selection teacher identity mismatch');
  check(m.schema === 'chessy.natural-pilot-selection.v1' && m.status === 'complete-research-only-selection' &&
    m.coverage.fullPilotReady === true && m.productionFitAllowed === false, 'selection is incomplete or failed preregistered coverage');
  teacherContract(teacher.value);
  check(HEX.test(m.source.sha256) && HEX.test(m.source.uncompressedSha256), 'source identities missing');
  check(m.source.sha256 === rules.value.source.sha256 && m.source.games === rules.value.source.games, 'frozen source inventory differs');
  const workers = rules.value.labeling.workers;
  check(Number.isSafeInteger(workers) && workers >= 1 && workers <= 16, 'invalid frozen worker count');
  check(rules.value.labeling.positionCommand === 'startpos-full-prefix', 'history semantics are not preregistered');
  const maxAbsCp = fit.value.teacherAdmission.maxAbsCp;
  check(maxAbsCp === 2000, 'frozen 2000cp fit admission required');
  const rows = [], snapshots = [], ids = new Set(), paths = new Set(), clusters = new Set(), games = new Set(), families = new Map();
  const base = path.dirname(selection.file);
  check(Array.isArray(m.selection.files) && m.selection.files.length === ROLES.length, 'complete five-role selection required');
  for (const role of ROLES) {
    const entry = m.selection.files.find(f => f.path === role + '.ndjson');
    check(entry && !paths.has(entry.path), 'missing/duplicate selected role ' + role); paths.add(entry.path);
    const retained = snapshot(path.join(base, entry.path), entry.sha256); snapshots.push(retained);
    check(retained.bytes.length === entry.bytes, 'selected byte size differs');
    const text = retained.bytes.toString('utf8');
    check(text === '' || text.endsWith('\n'), 'truncated selected input');
    const list = text === '' ? [] : text.slice(0, -1).split('\n').map(line => JSON.parse(line));
    check(list.length === entry.rows, 'selected row count differs');
    for (const row of list) {
      check(row.role === role && HEX.test(row.id || '') && !ids.has(row.id), 'duplicate ID or mixed selected role');
      check(HEX.test(row.positionFamily || '') && HEX.test(row.cluster || ''), 'invalid family or cluster');
      const cell = parseInt(row.positionFamily.slice(0, 12), 16) % 100;
      const range = rules.value.selection.roles[role];
      check(cell >= range[0] && cell < range[1], 'family assigned to incorrect role');
      check(row.sourceGame && /^[A-Za-z0-9]{8}$/.test(row.sourceId) && row.sourceGame.id === row.sourceId,
        'invalid source-game identity');
      check(row.id === sha256(rules.value.id + '\0' + m.source.sha256 + '\0' + row.sourceId + '\0' + row.sourceGame.selectedPly),
        'selected row identity recomputation differs');
      check(!clusters.has(row.cluster) && !games.has(row.sourceId), 'duplicate model cluster or source game');
      clusters.add(row.cluster); games.add(row.sourceId);
      families.set(row.positionFamily, (families.get(row.positionFamily) || 0) + 1);
      check(families.get(row.positionFamily) <= rules.value.selection.maximumRowsPerFamily, 'family cap exceeded');
      ids.add(row.id); rows.push(row);
    }
  }
  check(rows.length === m.selection.rows && rows.length > 0 && rows.length <= 50000, 'complete selected inventory differs');
  return { selection, rules, fit, teacher, rows, snapshots, workers, maxAbsCp };
}
function partition(rows, results) {
  check(results.length === rows.length, 'incomplete partition');
  const accepted = Object.fromEntries(ROLES.map(role => [role, []])), excluded = [];
  rows.forEach((row, index) => {
    const r = results[index];
    check(r && r.id === row.id && r.index === index && typeof r.accepted === 'boolean', 'partition identity mismatch');
    if (r.accepted) accepted[row.role].push({ ...row, teacher: r.teacher });
    else excluded.push({ ...row, exclusion: { reason: r.reason, detail: r.detail || null, attempted: r.attempted } });
  });
  return { accepted, excluded };
}
async function run(a) {
  const input = loadInputs(a), implementation = implementationHashes();
  // The output directory itself is the exclusive no-replace run-prefix lock.
  // It remains on any failure, so neither reruns nor cleanup erase evidence.
  fs.mkdirSync(a.output, { mode: 0o700 });
  const results = new Array(input.rows.length), failures = [], workers = [], activeEngines = new Set();
  let integrityFailure = null;
  function noteIntegrity(error) {
    if (error.code !== 'EARTIFACTINTEGRITY') return;
    integrityFailure = error;
    for (const engine of activeEngines) engine.forceKill();
  }
  let staged = null, stageFailure = null;
  try { staged = Label.stageVerifiedExecutable(a.stockfish, input.teacher.value.engine.executable.sha256); }
  catch (error) { stageFailure = error; failures.push({ phase: 'executable', message: error.message }); }
  try {
    await Promise.all(Array.from({ length: input.workers }, async (_, slot) => {
      const directory = path.join(a.output, 'worker-' + slot); fs.mkdirSync(directory);
      const transcript = new Writer(path.join(a.output, 'worker-' + slot + '.uci.jsonl'));
      const ledger = new Writer(path.join(a.output, 'worker-' + slot + '.partition.jsonl'));
      const assigned = input.rows.map((row, index) => ({ row, index })).filter(item => item.index % input.workers === slot);
      let engine = null, current = null, failed = stageFailure, attempted = false, networks = null;
      const raw = { append(line) { transcript.append({ rowId: current && current.row.id, index: current && current.index, line }); } };
      function save(item, record, preserveOnly = false) {
        const result = { index: item.index, id: item.row.id, ...record };
        check(!results[item.index], 'duplicate result'); results[item.index] = result;
        ledger.append(result); ledger.sync(); if (!preserveOnly) transcript.sync();
      }
      try {
        if (failed) throw failed;
        engine = new NaturalUci(staged, raw, input.teacher.value.watchdog, directory);
        activeEngines.add(engine);
        await engine.initialize(input.teacher.value.uci);
        const names = await engine.exportNetworks('export_net big.nnue small.nnue');
        networks = names.map((name, i) => {
          const expected = input.teacher.value.engine.networks[i];
          const retained = snapshot(path.join(directory, name), expected.sha256);
          check(retained.bytes.length === expected.bytes, 'network byte size mismatch');
          fs.unlinkSync(retained.file);
          return { option: expected.option, sha256: retained.sha256, bytes: retained.bytes.length };
        });
        for (const item of assigned) {
          if (integrityFailure) throw integrityFailure;
          current = item; attempted = false;
          raw.append('# row-start ' + item.row.id);
          const state = replayRow(item.row);
          attempted = true;
          const result = await engine.labelNatural(item.row, input.teacher.value);
          const assessment = assess(result, item.row, input.teacher.value, input.maxAbsCp, state);
          raw.append('# row-end ' + (assessment.eligible ? 'accepted' : assessment.reason));
          save(item, assessment.eligible ? { accepted: true, teacher: assessment.teacher, attempted: true } :
            { accepted: false, reason: assessment.reason, detail: assessment.detail || null, attempted: true });
          current = null;
        }
        await engine.quit();
      } catch (error) {
        noteIntegrity(error);
        failed = error;
        const failedIndex = current && current.index, failedAttempted = attempted;
        failures.push({ slot, index: failedIndex, message: error.message });
        try { raw.append('# worker-failure ' + error.message); }
        catch (recordError) { noteIntegrity(recordError); failures.push({ slot, phase: 'failure-transcript', message: recordError.message }); }
        if (engine) await engine.abort();
        for (const item of assigned) {
          if (results[item.index]) continue;
          current = item;
          try { if (!integrityFailure) raw.append('# excluded-after-failure'); }
          catch (recordError) { noteIntegrity(recordError); }
          try {
            save(item, { accepted: false, reason: item.index === failedIndex ? 'teacher-or-input-failure' : 'not-attempted-worker-failed',
              detail: { message: error.message }, attempted: failedAttempted && item.index === failedIndex }, true);
          } catch (recordError) {
            noteIntegrity(recordError);
            failures.push({ slot, phase: 'failure-ledger', index: item.index, message: recordError.message });
          }
        }
      } finally {
        if (engine) activeEngines.delete(engine);
        function close(writer) {
          try { return writer.close(); }
          catch (error) {
            failed = error; noteIntegrity(error); failures.push({ slot, phase: 'artifact-close', message: error.message });
            return { path: path.basename(writer.file), status: 'invalid', expectedSha256: writer.hash.copy().digest('hex'),
              expectedBytes: writer.bytes, expectedRows: writer.rows, error: error.message };
          }
        }
        const transcriptResult = close(transcript), partitionResult = close(ledger);
        workers.push({ slot, status: failed ? 'failed' : 'completed', networks,
          transcript: transcriptResult, partition: partitionResult });
        // Export failures can leave network evidence in this owned directory.
        // Preserve it rather than throwing away the full failure partition.
        if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
      }
    }));
  } finally { if (staged) Label.cleanupVerifiedExecutable(staged); }
  const parts = partition(input.rows, results), files = [];
  for (const role of ROLES) {
    const writer = new Writer(path.join(a.output, role + '.ndjson'));
    parts.accepted[role].forEach(row => writer.append(row)); files.push({ role, ...writer.close() });
  }
  const exclusionWriter = new Writer(path.join(a.output, 'excluded.ndjson'));
  parts.excluded.forEach(row => exclusionWriter.append(row));
  const exclusions = exclusionWriter.close();
  try {
    check(stable(implementationHashes()) === stable(implementation), 'implementation changed during labeling');
  } catch (error) { failures.push({ phase: 'publication', message: error.message }); }
  for (const retained of [input.selection, input.rules, input.fit, input.teacher, ...input.snapshots]) {
    try { check(fileHash(retained.file) === retained.sha256, 'input changed: ' + retained.file); }
    catch (error) { failures.push({ phase: 'publication', message: error.message }); }
  }
  const summary = { schema: SCHEMA, status: failures.length ? 'failed' : 'completed',
    disposition: 'research-only-not-production-fit-eligible', formalPass: false,
    execution: { workers: input.workers, assignment: 'complete-role-order-index-mod-workers',
      positionCommand: 'startpos-full-prefix', retry: false, trust: 'isolated-trusted-runner-no-same-uid-adversary-seal' },
    teacher: input.teacher.value, output: { selectedRows: input.rows.length,
      acceptedRows: input.rows.length - exclusions.rows, excludedRows: exclusions.rows,
      exclusionFraction: exclusions.rows / input.rows.length, files, exclusions },
    provenance: { selectionManifestSha256: input.selection.sha256, preregistrationSha256: input.rules.sha256,
      fitPreregistrationSha256: input.fit.sha256, teacherManifestSha256: input.teacher.sha256,
      sourceSha256: input.selection.value.source.sha256,
      sourceUncompressedSha256: input.selection.value.source.uncompressedSha256,
      implementation, runtime: { node: process.version, platform: process.platform, arch: process.arch } },
    workers: workers.sort((a, b) => a.slot - b.slot), failures };
  // Authenticated data first, completion metadata last under the output lock.
  const writer = new Writer(path.join(a.output, 'summary.json')); writer.append(summary); writer.close();
  return summary;
}
function parseArgs(argv) {
  const names = ['selection-manifest', 'selection-manifest-sha256', 'rules', 'rules-sha256',
    'fit-rules', 'fit-rules-sha256', 'teacher-manifest', 'teacher-manifest-sha256', 'stockfish', 'output'];
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i].slice(2);
    check(argv[i].startsWith('--') && names.includes(name) && !Object.hasOwn(out, name), 'unknown/duplicate CLI flag');
    check(argv[i + 1] && !argv[i + 1].startsWith('--'), 'missing CLI value'); out[name] = argv[i + 1];
  }
  check(names.every(name => Object.hasOwn(out, name)), 'all frozen inputs and external digests are required');
  for (const name of names) if (!name.endsWith('sha256')) out[name] = path.resolve(out[name]);
  return out;
}
function inventoryInterruptedRun(directory) {
  const root = path.resolve(directory), files = [];
  function visit(parent) {
    for (const name of fs.readdirSync(parent).sort()) {
      const file = path.join(parent, name), stat = fs.lstatSync(file);
      check(!stat.isSymbolicLink(), 'interruption inventory refuses symlinks');
      if (stat.isDirectory()) { visit(file); continue; }
      check(stat.isFile(), 'interruption inventory requires regular files');
      const fd = fs.openSync(file, 'r'); let bytes;
      try {
        const retained = fs.fstatSync(fd);
        check(retained.dev === stat.dev && retained.ino === stat.ino, 'inventory pathname replaced before read');
        bytes = fs.readFileSync(fd);
        const after = fs.fstatSync(fd), named = fs.lstatSync(file);
        check(after.dev === stat.dev && after.ino === stat.ino && after.size === stat.size &&
          after.mtimeMs === stat.mtimeMs && named.dev === stat.dev && named.ino === stat.ino && named.size === stat.size &&
          named.mtimeMs === stat.mtimeMs, 'inventory requires a stopped, unchanged run');
      } finally { fs.closeSync(fd); }
      const entry = { path: path.relative(root, file), bytes: bytes.length, sha256: sha256(bytes),
        device: stat.dev, inode: stat.ino, mtimeMs: stat.mtimeMs };
      if (/\.jsonl$/.test(name)) {
        const lines = bytes.toString('utf8').split('\n');
        entry.endsWithNewline = bytes.length === 0 || bytes[bytes.length - 1] === 10;
        if (entry.endsWithNewline) lines.pop();
        entry.completeLines = entry.endsWithNewline ? lines.length : Math.max(0, lines.length - 1);
        entry.malformedLines = 0;
        const identities = new Set();
        if (/\.partition\.jsonl$/.test(name)) entry.dispositions = { accepted: 0, excluded: 0, unknown: 0 };
        for (const line of lines.slice(0, entry.completeLines)) {
          try {
            const row = JSON.parse(line);
            const id = row.rowId || row.id;
            if (typeof id === 'string') identities.add(id);
            if (entry.dispositions) entry.dispositions[row.accepted === true ? 'accepted' : row.accepted === false ? 'excluded' : 'unknown']++;
          } catch (_) { entry.malformedLines++; }
        }
        entry.uniqueRowIdentities = identities.size;
      }
      files.push(entry);
    }
  }
  visit(root);
  return { schema: 'chessy.natural-pilot-interrupted-inventory.v1', status: 'infrastructure-invalid',
    disposition: 'preserved-unusable-partial-run-no-fitter-admission', productionFitAllowed: false,
    formalPass: false, retryAllowed: false, sourceDirectory: root,
    observedAt: new Date().toISOString(), completionMarkerPresent: files.some(f => f.path === 'summary.json'),
    inspectedFields: 'file hashes, sizes, inodes, line counts, row identity coverage and acceptance/exclusion counts only; no scores or model metrics', files };
}
async function main(argv) {
  if (argv[0] === '--inventory-interrupted') {
    check(argv.length === 4 && argv[2] === '--inventory-output', 'inventory requires --inventory-interrupted DIR --inventory-output NEWFILE');
    const inventory = inventoryInterruptedRun(argv[1]);
    check(!path.resolve(argv[3]).startsWith(path.resolve(argv[1]) + path.sep), 'inventory output must be separate from preserved run');
    const writer = new Writer(path.resolve(argv[3])); writer.append(inventory); writer.close();
    console.log(JSON.stringify({ status: inventory.status, files: inventory.files.length }));
    return;
  }
  const summary = await run(parseArgs(argv));
  console.log(JSON.stringify({ status: summary.status, ...summary.output }));
  if (summary.status !== 'completed') process.exitCode = 1;
}
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error('natural-pilot-label: ' + error.message); process.exitCode = 1;
});
module.exports = { sha256, stable, snapshot, replayRow, teacherContract, NaturalUci, assess, Writer,
  loadInputs, partition, run, parseArgs, inventoryInterruptedRun, ROLES, SCHEMA };
