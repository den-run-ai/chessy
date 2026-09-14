#!/usr/bin/env node
/*
 * Offline PGN -> E4-v1 opening-candidate compiler.
 *
 * The command-line path is deliberately closed over the checked-in source
 * policy. It does not download data and accepts no URL, checksum, sampling,
 * filter, teacher, or node-budget overrides:
 *
 *   node test/eval/prepare-e4-opening-candidates.js \
 *     --input /data/lichess_db_standard_rated_2026-06.pgn.zst \
 *     --output /data/e4-opening-candidates.ndjson \
 *     --stockfish /opt/stockfish/stockfish-ubuntu-x86-64-avx2
 *
 * The complete compressed input is authenticated before zstd starts. The
 * Stockfish executable is authenticated before Stockfish starts. Output and
 * its sidecar are no-replace artifacts. Nothing in this file is imported by
 * the shipped application.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');

require('../../assets/engine.js');
require('../../assets/pgn.js');

const Corpus = require('../training/corpus.js');
const Prepare = require('../training/prepare-lichess-evals.js');
const Label = require('../training/label-stockfish.js');
const Freezer = require('./freeze-e4-manifests.js');

const ROOT = path.join(__dirname, '..', '..');
const SOURCE_POLICY_RELATIVE =
  'eval/e4/opening-candidate-source-v1.json';
const SOURCE_POLICY_PATH = path.join(ROOT, SOURCE_POLICY_RELATIVE);
const SOURCE_POLICY_SCHEMA_RELATIVE =
  'eval/e4/opening-candidate-source.schema.json';
const CANDIDATE_SCHEMA_RELATIVE =
  'eval/e4/opening-candidate.schema.json';
const SIDECAR_SCHEMA_RELATIVE =
  'eval/e4/opening-candidate-sidecar.schema.json';
const FREEZE_REQUEST_SCHEMA_RELATIVE =
  'eval/e4/freeze-request.schema.json';
const COMPILER_RELATIVE =
  'test/eval/prepare-e4-opening-candidates.js';
const ENGINE_RELATIVE = 'assets/engine.js';
const PGN_RELATIVE = 'assets/pgn.js';
const CORPUS_RELATIVE = 'test/training/corpus.js';
const PREPARE_RELATIVE =
  'test/training/prepare-lichess-evals.js';
const LABEL_RELATIVE = 'test/training/label-stockfish.js';
const FREEZER_RELATIVE = 'test/eval/freeze-e4-manifests.js';
const E4_PROTOCOL_RELATIVE = 'test/eval/e4-protocol.js';
const TEACHER_RELATIVE =
  'eval/training/teacher-sf18-100kn-v1.json';
const HELDOUT_RELATIVE = 'eval/training/heldout-v1.json';
const TRAINING_SOURCE_POLICY_RELATIVE =
  'eval/training/source-manifest.json';
const HEX_256 = /^[0-9a-f]{64}$/;
const GAME_ID = /^[A-Za-z0-9]{8}$/;
const OPAQUE_GAME_ID =
  /^chessy\.e4\.lichess-standard-rated\.2026-06:game:[0-9a-f]{64}$/;
const OPAQUE_RECORD_ID =
  /^chessy\.e4\.lichess-standard-rated\.2026-06:candidate:[0-9a-f]{64}$/;
const CANDIDATE_KEYS = Object.freeze([
  'schema',
  'recordId',
  'sourceGameId',
  'fen',
  'eco',
  'openingFamily',
  'initialBalanceCp'
]);
const EXCLUSION_REASONS = Object.freeze([
  'nonstandard-initial-position',
  'ineligible-event',
  'bot-player',
  'missing-player',
  'self-play',
  'elo-below-minimum-or-missing',
  'missing-or-invalid-eco',
  'missing-or-invalid-opening',
  'hash-sample-rejected',
  'invalid-pgn',
  'candidate-ply-unavailable',
  'legal-replay-failed',
  'terminal-candidate-position',
  'incident-cluster-or-family',
  'sample-cap-pruned',
  'teacher-mate-score',
  'teacher-missing-score',
  'teacher-missing-cp',
  'teacher-bound-score',
  'teacher-reported-nodes-under-budget',
  'teacher-invalid-score-nodes',
  'teacher-missing-wdl',
  'teacher-invalid-wdl',
  'teacher-invalid-search-depth',
  'teacher-bestmove-pv-mismatch',
  'teacher-invalid-white-pov-target',
  'teacher-abs-cp-over-200'
]);
const EXCLUSION_REASON_SET = new Set(EXCLUSION_REASONS);
const BEFORE_SOURCE_ELIGIBLE_REASONS = Object.freeze([
  'nonstandard-initial-position',
  'ineligible-event',
  'bot-player',
  'missing-player',
  'self-play',
  'elo-below-minimum-or-missing',
  'missing-or-invalid-eco',
  'missing-or-invalid-opening'
]);
const BEFORE_LEGAL_POSITION_REASONS = Object.freeze([
  'invalid-pgn',
  'candidate-ply-unavailable',
  'legal-replay-failed',
  'terminal-candidate-position',
  'incident-cluster-or-family'
]);
const TEACHER_EXCLUSION_REASONS = Object.freeze(
  EXCLUSION_REASONS.filter(function (reason) {
    return reason.startsWith('teacher-');
  })
);
const POLICY_KEYS = Object.freeze([
  'schema', 'status', 'source', 'filters', 'identity', 'extraction', 'output'
]);
const SOURCE_KEYS = Object.freeze([
  'id', 'dataset', 'release', 'archive', 'forbiddenSources'
]);
const ARCHIVE_KEYS = Object.freeze([
  'url', 'bytes', 'sha256', 'compression', 'license'
]);
const FILTER_KEYS = Object.freeze([
  'initialPosition', 'variantTags', 'ratedSpeeds', 'ratedEventKinds',
  'minimumElo', 'botTitle', 'botsAllowed', 'selfPlayAllowed'
]);
const IDENTITY_KEYS = Object.freeze([
  'sitePrefix', 'gameIdRegex', 'caseSensitive', 'outputIdNamespace',
  'rawIdRetention'
]);
const EXTRACTION_KEYS = Object.freeze([
  'metadata', 'candidatePly', 'sampling', 'teacher', 'balance',
  'incidentDenial'
]);
const OUTPUT_KEYS = Object.freeze([
  'schema', 'format', 'order', 'overwrite', 'sidecarSchema'
]);

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function isObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  assert(isObject(value), label + ' must be an object');
  const actual = Object.keys(value).sort();
  const wanted = expected.slice().sort();
  assert(Prepare.stableJson(actual) === Prepare.stableJson(wanted),
    label + ' must contain exactly [' + wanted.join(', ') + ']');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validArtifactBasename(value) {
  return typeof value === 'string' &&
    /^[^/\\\u0000-\u001f\u007f]+$/.test(value);
}

function loadSourcePolicyArtifact(filename) {
  const file = filename || SOURCE_POLICY_PATH;
  const bytes = fs.readFileSync(file);
  const policy = JSON.parse(bytes.toString('utf8'));
  validateSourcePolicy(policy);
  return {
    policy,
    sha256: sha256(bytes)
  };
}

function loadSourcePolicy(filename) {
  return loadSourcePolicyArtifact(filename).policy;
}

function validateSourcePolicy(policy) {
  exactKeys(policy, POLICY_KEYS, 'opening source policy');
  assert(policy.schema ===
      'chessy.e4.opening-candidate-source-policy.v1' &&
    policy.status === 'preregistered',
  'opening source policy identity/status drifted');

  exactKeys(policy.source, SOURCE_KEYS, 'source');
  assert(policy.source.id === 'lichess-standard-rated-pgn' &&
    policy.source.dataset === 'Lichess standard rated games' &&
    policy.source.release === '2026-06',
  'source dataset/release drifted');
  exactKeys(policy.source.archive, ARCHIVE_KEYS, 'source archive');
  const archive = policy.source.archive;
  assert(archive.url ===
      'https://database.lichess.org/standard/' +
      'lichess_db_standard_rated_2026-06.pgn.zst' &&
    archive.bytes === 28241946492 &&
    archive.sha256 ===
      '8fd81071f56511e7546cb77e38db5cf32f7e8a437fb906e26959cc064d8b1f79' &&
    archive.compression === 'zstd' &&
    archive.license === 'CC0-1.0',
  'official direct June 2026 archive pin drifted');
  assert(Array.isArray(policy.source.forbiddenSources) &&
    policy.source.forbiddenSources.length === 1,
  'source policy must contain the one explicit stale-torrent denial');
  const forbidden = policy.source.forbiddenSources[0];
  exactKeys(forbidden, ['url', 'accepted', 'reason'], 'forbidden source');
  assert(forbidden.url === archive.url + '.torrent' &&
    forbidden.accepted === false &&
    forbidden.reason ===
      'stale-torrent-metadata-is-not-source-evidence',
  'stale torrent must remain explicitly forbidden');

  exactKeys(policy.filters, FILTER_KEYS, 'source filters');
  assert(policy.filters.initialPosition ===
      'standard-only-no-SetUp-or-FEN' &&
    Prepare.stableJson(policy.filters.variantTags) ===
      Prepare.stableJson(['absent', 'Standard']) &&
    Prepare.stableJson(policy.filters.ratedSpeeds) ===
      Prepare.stableJson([
        'Blitz',
        'Rapid',
        'Classical'
      ]) &&
    Prepare.stableJson(policy.filters.ratedEventKinds) ===
      Prepare.stableJson([
        'game',
        'tournament',
        'swiss'
      ]) &&
    policy.filters.minimumElo === 1800 &&
    policy.filters.botTitle === 'BOT' &&
    policy.filters.botsAllowed === false &&
    policy.filters.selfPlayAllowed === false,
  'fixed source filters drifted');

  exactKeys(policy.identity, IDENTITY_KEYS, 'source identity');
  assert(policy.identity.sitePrefix === 'https://lichess.org/' &&
    policy.identity.gameIdRegex === '^[A-Za-z0-9]{8}$' &&
    policy.identity.caseSensitive === true &&
    policy.identity.outputIdNamespace ===
      'chessy.e4.lichess-standard-rated.2026-06' &&
    policy.identity.rawIdRetention ===
      'forbidden-in-candidate-output',
  'source identity/privacy policy drifted');

  exactKeys(policy.extraction, EXTRACTION_KEYS, 'extraction policy');
  exactKeys(policy.extraction.metadata,
    ['eco', 'openingFamily', 'maximumOpeningCharacters'],
    'metadata policy');
  assert(policy.extraction.metadata.eco ===
      'trimmed-[A-E][0-9]{2}' &&
    policy.extraction.metadata.openingFamily ===
      'NFC-trimmed-prefix-before-first-colon' &&
    policy.extraction.metadata.maximumOpeningCharacters === 256,
  'ECO/opening metadata policy drifted');
  exactKeys(policy.extraction.candidatePly,
    ['minimum', 'maximum', 'algorithm', 'domain'],
    'candidate-ply policy');
  assert(policy.extraction.candidatePly.minimum === 12 &&
    policy.extraction.candidatePly.maximum === 20 &&
    policy.extraction.candidatePly.algorithm ===
      'sha256-modulo-inclusive-window' &&
    policy.extraction.candidatePly.domain ===
      'chessy.e4.opening-candidate-ply.v1',
  'candidate-ply policy drifted');
  exactKeys(policy.extraction.sampling,
    ['algorithm', 'domain', 'modulus', 'numerator',
      'maximumCandidates', 'overflow'],
    'sampling policy');
  assert(policy.extraction.sampling.algorithm ===
      'sha256-threshold-then-lowest-digest' &&
    policy.extraction.sampling.domain ===
      'chessy.e4.opening-candidate-sample.v1' &&
    policy.extraction.sampling.modulus === 4096 &&
    policy.extraction.sampling.numerator === 64 &&
    policy.extraction.sampling.maximumCandidates === 25000 &&
    policy.extraction.sampling.overflow ===
      'retain-lowest-full-digests',
  'deterministic sampling/cap policy drifted');
  exactKeys(policy.extraction.teacher,
    ['manifest', 'id', 'engine', 'nodeLimit', 'scorePov'],
    'teacher policy');
  assert(policy.extraction.teacher.manifest === TEACHER_RELATIVE &&
    policy.extraction.teacher.id === 'sf18-100kn-v1' &&
    policy.extraction.teacher.engine === 'Stockfish 18' &&
    policy.extraction.teacher.nodeLimit === 100000 &&
    policy.extraction.teacher.scorePov === 'white',
  'pinned teacher policy drifted');
  exactKeys(policy.extraction.balance,
    ['scoreKind', 'maximumAbsoluteCp', 'mateAllowed', 'boundAllowed'],
    'balance policy');
  assert(policy.extraction.balance.scoreKind === 'exact-cp' &&
    policy.extraction.balance.maximumAbsoluteCp === 200 &&
    policy.extraction.balance.mateAllowed === false &&
    policy.extraction.balance.boundAllowed === false &&
    policy.extraction.incidentDenial ===
      'cluster-and-position-family-before-scoring',
  'balance/incident policy drifted');

  exactKeys(policy.output, OUTPUT_KEYS, 'output policy');
  assert(policy.output.schema ===
      'chessy.e4.opening-candidate.v1' &&
    policy.output.format === 'canonical-ndjson' &&
    policy.output.order === 'recordId-unicode-code-point' &&
    policy.output.overwrite === false &&
    policy.output.sidecarSchema ===
      'chessy.e4.opening-candidate-sidecar.v1',
  'output policy drifted');
  return policy;
}

function configurationSha256(policy) {
  validateSourcePolicy(policy);
  return sha256(Prepare.stableJson({
    filters: policy.filters,
    identity: policy.identity,
    extraction: policy.extraction,
    output: policy.output
  }));
}

function hashFileSync(filename) {
  return sha256(fs.readFileSync(filename));
}

function dependencyHashes(root) {
  const repositoryRoot = root || ROOT;
  const relativePaths = {
    sourcePolicy: SOURCE_POLICY_RELATIVE,
    sourcePolicySchema: SOURCE_POLICY_SCHEMA_RELATIVE,
    candidateSchema: CANDIDATE_SCHEMA_RELATIVE,
    sidecarSchema: SIDECAR_SCHEMA_RELATIVE,
    freezeRequestSchema: FREEZE_REQUEST_SCHEMA_RELATIVE,
    compiler: COMPILER_RELATIVE,
    engine: ENGINE_RELATIVE,
    pgn: PGN_RELATIVE,
    corpus: CORPUS_RELATIVE,
    prepare: PREPARE_RELATIVE,
    labelStockfish: LABEL_RELATIVE,
    candidateValidator: FREEZER_RELATIVE,
    e4Protocol: E4_PROTOCOL_RELATIVE,
    teacher: TEACHER_RELATIVE,
    heldout: HELDOUT_RELATIVE,
    trainingSourcePolicy: TRAINING_SOURCE_POLICY_RELATIVE
  };
  const out = {};
  Object.keys(relativePaths).forEach(function (name) {
    const relative = relativePaths[name];
    const file = path.join(repositoryRoot, relative);
    out[name] = {
      path: relative,
      sha256: hashFileSync(file)
    };
  });
  const heldout = JSON.parse(fs.readFileSync(
    path.join(repositoryRoot, HELDOUT_RELATIVE), 'utf8'));
  assert(typeof heldout.sourceFixture === 'string' &&
    !path.isAbsolute(heldout.sourceFixture) &&
    !heldout.sourceFixture.split(/[\\/]/).includes('..') &&
    HEX_256.test(heldout.sourceFixtureSha256 || ''),
  'held-out source fixture provenance is malformed');
  const fixtureHash = hashFileSync(path.join(
    repositoryRoot, heldout.sourceFixture));
  assert(fixtureHash === heldout.sourceFixtureSha256,
    'held-out source fixture hash drifted');
  out.heldoutFixture = {
    path: heldout.sourceFixture,
    sha256: fixtureHash
  };
  return out;
}

function assertDependencyHashesUnchanged(expected, root) {
  assert(isObject(expected),
    'initial compiler dependency hashes are required');
  const actual = dependencyHashes(root);
  assert(Prepare.stableJson(actual) === Prepare.stableJson(expected),
    'compiler dependencies changed during the run');
  return actual;
}

async function fileSha256(filename) {
  const hash = crypto.createHash('sha256');
  const input = fs.createReadStream(filename);
  for await (const chunk of input) hash.update(chunk);
  return hash.digest('hex');
}

function fileMetadata(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs
  };
}

function sameFileMetadata(left, right) {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

async function authenticateInputFile(filename, expected) {
  assert(isObject(expected) &&
    Number.isSafeInteger(expected.bytes) && expected.bytes >= 0 &&
    HEX_256.test(expected.sha256 || ''),
  'input identity must contain pinned bytes and SHA-256');
  const resolved = path.resolve(filename);
  const fd = fs.openSync(resolved, 'r');
  let keepOpen = false;
  try {
    const beforeStat = fs.fstatSync(fd);
    assert(beforeStat.isFile(), 'input must be a regular file');
    const before = fileMetadata(beforeStat);
    assert(before.size === expected.bytes,
      'input byte size does not match the source policy');
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(resolved, {
      fd,
      start: 0,
      autoClose: false
    });
    for await (const chunk of input) hash.update(chunk);
    const after = fileMetadata(fs.fstatSync(fd));
    assert(sameFileMetadata(before, after),
      'input changed while it was being authenticated');
    const actualSha256 = hash.digest('hex');
    assert(actualSha256 === expected.sha256,
      'input SHA-256 does not match the source policy');
    let closed = false;
    const authenticated = {
      filename: resolved,
      fd,
      identity: {
        bytes: after.size,
        sha256: actualSha256
      },
      createReadStream: function () {
        assert(!closed, 'authenticated input is closed');
        return fs.createReadStream(resolved, {
          fd,
          start: 0,
          autoClose: false
        });
      },
      assertUnchanged: function () {
        assert(!closed, 'authenticated input is closed');
        assert(sameFileMetadata(after, fileMetadata(fs.fstatSync(fd))),
          'authenticated input changed before parsing completed');
      },
      close: function () {
        if (closed) return;
        closed = true;
        fs.closeSync(fd);
      }
    };
    keepOpen = true;
    return authenticated;
  } finally {
    if (!keepOpen) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

async function verifyInputFile(filename, expected) {
  const authenticated = await authenticateInputFile(filename, expected);
  try {
    return jsonClone(authenticated.identity);
  } finally {
    authenticated.close();
  }
}

function prepareVerifiedExecutable(filename, expectedSha256) {
  assert(HEX_256.test(expectedSha256 || ''),
    'expected executable SHA-256 must be pinned');
  const resolved = path.resolve(filename);
  const sourceFd = fs.openSync(resolved, 'r');
  let targetFd = null;
  let directory = null;
  try {
    const beforeStat = fs.fstatSync(sourceFd);
    assert(beforeStat.isFile(),
      '--stockfish must name a regular executable file');
    const before = fileMetadata(beforeStat);
    directory = fs.mkdtempSync(path.join(
      os.tmpdir(), 'chessy-e4-stockfish-'));
    const target = path.join(directory, 'stockfish');
    targetFd = fs.openSync(target, 'wx', 0o500);
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    for (;;) {
      const bytesRead = fs.readSync(
        sourceFd, buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        written += fs.writeSync(
          targetFd, buffer, written, bytesRead - written);
      }
      position += bytesRead;
    }
    assert(sameFileMetadata(
      before, fileMetadata(fs.fstatSync(sourceFd))),
    'Stockfish executable changed while it was being authenticated');
    const actualSha256 = hash.digest('hex');
    assert(actualSha256 === expectedSha256,
      'Stockfish executable does not match the checked-in teacher manifest');
    fs.fsyncSync(targetFd);
    fs.closeSync(targetFd);
    targetFd = null;
    fs.closeSync(sourceFd);
    fs.chmodSync(target, 0o500);
    fs.chmodSync(directory, 0o500);
    let cleaned = false;
    return {
      path: target,
      sha256: actualSha256,
      cleanup: function () {
        if (cleaned) return;
        cleaned = true;
        try { fs.chmodSync(directory, 0o700); } catch (_) {}
        fs.rmSync(directory, { recursive: true, force: true });
      }
    };
  } catch (error) {
    if (targetFd != null) {
      try { fs.closeSync(targetFd); } catch (_) {}
    }
    try { fs.closeSync(sourceFd); } catch (_) {}
    if (directory) {
      try {
        fs.rmSync(directory, { recursive: true, force: true });
      } catch (_) {}
    }
    throw error;
  }
}

function createPinnedEngine(verifiedExecutable, contracts, EngineClass) {
  assert(verifiedExecutable &&
    typeof verifiedExecutable.path === 'string' &&
    verifiedExecutable.path.length > 0 &&
    contracts && contracts.teacher,
  'verified executable and teacher contracts are required');
  const Constructor = EngineClass || Label.UciEngine;
  return new Constructor(
    verifiedExecutable.path,
    { append: function () {} },
    contracts.teacher.watchdog,
    path.dirname(verifiedExecutable.path)
  );
}

function openPgnSource(
  filename, compression, spawnImpl, authenticatedInput
) {
  if (compression === 'none') {
    return {
      stream: authenticatedInput ?
        authenticatedInput.createReadStream() :
        fs.createReadStream(filename),
      child: null,
      rawInput: null,
      done: Promise.resolve()
    };
  }
  assert(compression === 'zstd',
    'unsupported source compression: ' + compression);
  const launch = spawnImpl || spawn;
  const child = launch('zstd', authenticatedInput ?
    ['-dc'] : ['-dc', '--', filename], {
    stdio: [authenticatedInput ? 'pipe' : 'ignore', 'pipe', 'pipe']
  });
  let rawInput = null;
  let rawInputError = null;
  if (authenticatedInput) {
    rawInput = authenticatedInput.createReadStream();
    rawInput.once('error', function (error) {
      rawInputError = error;
      if (!child.killed) child.kill('SIGKILL');
    });
    child.stdin.once('error', function (error) {
      if (error.code !== 'EPIPE' && !rawInputError) rawInputError = error;
    });
    rawInput.pipe(child.stdin);
  }
  let stderr = '';
  if (child.stderr) {
    child.stderr.on('data', function (chunk) {
      if (stderr.length < 8192) stderr += String(chunk).slice(0, 8192);
    });
  }
  const done = new Promise(function (resolve, reject) {
    let spawnError = null;
    child.once('error', function (error) {
      spawnError = error;
      if (error.code === 'ENOENT') {
        error.message = 'zstd is required to read the pinned .zst archive';
      }
      reject(error);
    });
    child.once('close', function (code, signal) {
      if (spawnError) return;
      if (rawInputError) {
        reject(rawInputError);
        return;
      }
      if (code !== 0) {
        reject(new Error(
          'zstd failed with status ' + code +
          (signal ? ' (' + signal + ')' : '') +
          (stderr.trim() ? ': ' + stderr.trim() : '') +
          '; the archive may be truncated or corrupt'
        ));
        return;
      }
      resolve();
    });
  });
  return { stream: child.stdout, child, rawInput, done };
}

async function * splitPgnGames(chunks) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  const boundary = /(?:\r?\n){2,}(?=\[Event\s+")/;

  function takeOne() {
    const match = boundary.exec(buffer);
    if (!match) return null;
    const game = buffer.slice(0, match.index).trim();
    buffer = buffer.slice(match.index + match[0].length);
    return game;
  }

  for await (const chunk of chunks) {
    buffer += Buffer.isBuffer(chunk) ?
      decoder.write(chunk) : String(chunk);
    for (;;) {
      const game = takeOne();
      if (game == null) break;
      if (game) yield game;
    }
  }
  buffer += decoder.end();
  for (;;) {
    const game = takeOne();
    if (game == null) break;
    if (game) yield game;
  }
  const tail = buffer.trim();
  if (tail) yield tail;
}

function gameIdFromTags(tags, policy) {
  const site = tags && tags.Site;
  assert(typeof site === 'string' &&
    site.startsWith(policy.identity.sitePrefix),
  'PGN Site must contain a canonical Lichess game URL');
  const rawId = site.slice(policy.identity.sitePrefix.length);
  assert(GAME_ID.test(rawId),
    'PGN Site game ID must be one case-sensitive 8-character Lichess ID');
  return rawId;
}

function encodeGameId(rawId) {
  const alphabet =
    '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let value = 0;
  for (const character of rawId) {
    value = value * alphabet.length + alphabet.indexOf(character);
  }
  return value;
}

class DiskGameIdRegistry {
  constructor() {
    const { DatabaseSync } = require('node:sqlite');
    this.directory = fs.mkdtempSync(path.join(
      os.tmpdir(), 'chessy-e4-game-ids-'));
    this.filename = path.join(this.directory, 'ids.sqlite');
    this.database = new DatabaseSync(this.filename);
    this.database.exec(
      'PRAGMA journal_mode=OFF;' +
      'PRAGMA synchronous=OFF;' +
      'CREATE TABLE ids (id INTEGER PRIMARY KEY) WITHOUT ROWID;' +
      'BEGIN IMMEDIATE;'
    );
    this.insert = this.database.prepare(
      'INSERT OR IGNORE INTO ids (id) VALUES (?)');
    this.pending = 0;
    this.closed = false;
  }

  add(rawId) {
    assert(!this.closed, 'game ID registry is closed');
    const result = this.insert.run(encodeGameId(rawId));
    if (result.changes !== 1) {
      throw new Error('duplicate case-sensitive Lichess game ID');
    }
    this.pending++;
    if (this.pending >= 10000) {
      this.database.exec('COMMIT; BEGIN IMMEDIATE;');
      this.pending = 0;
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.database.exec('COMMIT;');
    } finally {
      try { this.insert.close(); } catch (_) {}
      try { this.database.close(); } finally {
        try { fs.unlinkSync(this.filename); } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        try { fs.rmdirSync(this.directory); } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    }
  }
}

class MemoryGameIdRegistry {
  constructor() {
    this.ids = new Set();
  }

  add(rawId) {
    const encoded = encodeGameId(rawId);
    if (this.ids.has(encoded)) {
      throw new Error('duplicate case-sensitive Lichess game ID');
    }
    this.ids.add(encoded);
  }

  close() {}
}

function digestCell(digest, modulus) {
  return parseInt(digest.slice(0, 12), 16) % modulus;
}

function candidatePly(rawId, policy) {
  const rule = policy.extraction.candidatePly;
  const digest = sha256(rule.domain + '\n' + rawId);
  return rule.minimum +
    digestCell(digest, rule.maximum - rule.minimum + 1);
}

function samplingDigest(rawId, policy) {
  return sha256(policy.extraction.sampling.domain + '\n' + rawId);
}

function sampleAccepted(rawId, policy) {
  const sample = policy.extraction.sampling;
  return digestCell(samplingDigest(rawId, policy), sample.modulus) <
    sample.numerator;
}

function opaqueSourceGameId(rawId, policy) {
  const namespace = policy.identity.outputIdNamespace;
  return namespace + ':game:' +
    sha256(namespace + '\nsource-game\n' + rawId);
}

function recordIdFor(sourceGameId, ply, fen, policy) {
  const namespace = policy.identity.outputIdNamespace;
  return namespace + ':candidate:' +
    sha256(namespace + '\nrecord\n' + sourceGameId + '\n' +
      ply + '\n' + fen);
}

function leadingTags(gameText) {
  const match = String(gameText).match(
    /^(?:\[\w+\s+"(?:[^"\\]|\\.)*"\]\s*)+/);
  assert(match, 'PGN game is missing a leading tag block');
  return ChessyPGN.parseTags(match[0]);
}

function filterReason(tags, policy) {
  if (Object.prototype.hasOwnProperty.call(tags, 'SetUp') ||
      Object.prototype.hasOwnProperty.call(tags, 'FEN') ||
      (Object.prototype.hasOwnProperty.call(tags, 'Variant') &&
        tags.Variant !== 'Standard')) {
    return 'nonstandard-initial-position';
  }
  const rated = /^Rated ([A-Za-z]+) ([A-Za-z]+)(?:\s|$)/
    .exec(tags.Event || '');
  if (!rated ||
      !policy.filters.ratedSpeeds.includes(rated[1]) ||
      !policy.filters.ratedEventKinds.includes(rated[2])) {
    return 'ineligible-event';
  }
  if (tags.WhiteTitle === policy.filters.botTitle ||
      tags.BlackTitle === policy.filters.botTitle) {
    return 'bot-player';
  }
  if (typeof tags.White !== 'string' || !tags.White ||
      typeof tags.Black !== 'string' || !tags.Black) {
    return 'missing-player';
  }
  if (tags.White === tags.Black) return 'self-play';
  if (!/^(?:0|[1-9][0-9]*)$/.test(tags.WhiteElo || '') ||
      !/^(?:0|[1-9][0-9]*)$/.test(tags.BlackElo || '') ||
      !Number.isSafeInteger(Number(tags.WhiteElo)) ||
      !Number.isSafeInteger(Number(tags.BlackElo)) ||
      Number(tags.WhiteElo) < policy.filters.minimumElo ||
      Number(tags.BlackElo) < policy.filters.minimumElo) {
    return 'elo-below-minimum-or-missing';
  }
  return null;
}

function normalizedEco(value) {
  return typeof value === 'string' &&
    value === value.trim() && /^[A-E][0-9]{2}$/.test(value) ?
    value : null;
}

function normalizedOpening(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFC');
  if (normalized !== normalized.trim() ||
      /[\u0000-\u001f\u007f]/.test(normalized) ||
      /(?:https?:\/\/|lichess\.org\/)/i.test(normalized)) return null;
  const opening = normalized.split(':', 1)[0].trim();
  if (!opening ||
      opening.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(opening)) return null;
  return opening;
}

function moveUci(move) {
  return Chess.sqName(move.from) + Chess.sqName(move.to) +
    (move.promotion ? move.promotion.toLowerCase() : '');
}

function replayToPly(game, ply) {
  assert(game && game.valid && Number.isSafeInteger(ply) && ply > 0,
    'valid parsed game and positive candidate ply are required');
  let state = Chess.newGameState();
  for (let index = 0; index < ply; index++) {
    const expected = game.moves[index] && game.moves[index].uci;
    assert(typeof expected === 'string',
      'parsed game ended before its deterministic candidate ply');
    const legal = Chess.legalMoves(state);
    const move = legal.find(function (candidate) {
      return moveUci(candidate) === expected;
    });
    assert(move,
      'PGN replay disagrees with assets/engine.js at ply ' + (index + 1));
    state = Chess.playMove(state, move);
  }
  return state;
}

function incidentDenied(fen, contracts) {
  return Corpus.clusterKey(fen) ===
      contracts.heldout.symmetryPolicy.clusterSha256 ||
    Corpus.positionFamilyKey(fen) ===
      contracts.heldout.symmetryPolicy.positionFamilySha256;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareSelection(left, right) {
  return compareText(left.selectionKey, right.selectionKey) ||
    compareText(left.recordId, right.recordId);
}

class BoundedCandidateHeap {
  constructor(limit) {
    assert(Number.isSafeInteger(limit) && limit > 0,
      'candidate heap limit must be positive');
    this.limit = limit;
    this.items = [];
  }

  swap(left, right) {
    const temporary = this.items[left];
    this.items[left] = this.items[right];
    this.items[right] = temporary;
  }

  siftUp(index) {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareSelection(this.items[index], this.items[parent]) <= 0) break;
      this.swap(index, parent);
      index = parent;
    }
  }

  siftDown(index) {
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let largest = index;
      if (left < this.items.length &&
          compareSelection(this.items[left], this.items[largest]) > 0) {
        largest = left;
      }
      if (right < this.items.length &&
          compareSelection(this.items[right], this.items[largest]) > 0) {
        largest = right;
      }
      if (largest === index) break;
      this.swap(index, largest);
      index = largest;
    }
  }

  offer(candidate) {
    if (this.items.length < this.limit) {
      this.items.push(candidate);
      this.siftUp(this.items.length - 1);
      return true;
    }
    if (compareSelection(candidate, this.items[0]) >= 0) return false;
    this.items[0] = candidate;
    this.siftDown(0);
    return true;
  }

  values() {
    return this.items.slice().sort(compareSelection);
  }
}

function newCounts() {
  return {
    gamesSeen: 0,
    sourceFilterEligible: 0,
    hashSampled: 0,
    legalCandidatePositions: 0,
    retainedForScoring: 0,
    scored: 0,
    outputRows: 0
  };
}

function exclude(exclusions, reason) {
  assert(EXCLUSION_REASON_SET.has(reason),
    'unregistered candidate exclusion reason: ' + reason);
  exclusions[reason] = (exclusions[reason] || 0) + 1;
}

function exclusionTotal(exclusions, reasons) {
  return reasons.reduce(function (total, reason) {
    return total + (exclusions[reason] || 0);
  }, 0);
}

async function extractCandidates(chunks, policy, options) {
  validateSourcePolicy(policy);
  const settings = options || {};
  const contracts = settings.contracts || Label.loadFrozenContracts();
  const registry = settings.registry || new DiskGameIdRegistry();
  const ownsRegistry = !settings.registry;
  const counts = newCounts();
  const exclusions = {};
  const heap = new BoundedCandidateHeap(
    policy.extraction.sampling.maximumCandidates);
  try {
    for await (const gameText of splitPgnGames(chunks)) {
      counts.gamesSeen++;
      assert(/^\[Event\s+"/.test(gameText),
        'every source game must begin with an Event tag');
      const tags = leadingTags(gameText);
      const rawId = gameIdFromTags(tags, policy);
      registry.add(rawId);

      const sourceFilter = filterReason(tags, policy);
      if (sourceFilter) {
        exclude(exclusions, sourceFilter);
        continue;
      }
      const eco = normalizedEco(tags.ECO);
      if (!eco) {
        exclude(exclusions, 'missing-or-invalid-eco');
        continue;
      }
      const openingFamily = normalizedOpening(tags.Opening);
      if (!openingFamily) {
        exclude(exclusions, 'missing-or-invalid-opening');
        continue;
      }
      counts.sourceFilterEligible++;
      if (!sampleAccepted(rawId, policy)) {
        exclude(exclusions, 'hash-sample-rejected');
        continue;
      }
      counts.hashSampled++;

      const ply = candidatePly(rawId, policy);
      const parsed = ChessyPGN.parseGame(gameText);
      if (!parsed.valid) {
        exclude(exclusions, 'invalid-pgn');
        continue;
      }
      if (parsed.plies < ply) {
        exclude(exclusions, 'candidate-ply-unavailable');
        continue;
      }
      let state;
      try {
        state = replayToPly(parsed, ply);
      } catch (_) {
        exclude(exclusions, 'legal-replay-failed');
        continue;
      }
      if (Chess.gameStatus(state).over) {
        exclude(exclusions, 'terminal-candidate-position');
        continue;
      }
      const fen = Corpus.validateSourceState(Chess.toFen(state)).fen6;
      if (incidentDenied(fen, contracts)) {
        exclude(exclusions, 'incident-cluster-or-family');
        continue;
      }
      counts.legalCandidatePositions++;

      const sourceGameId = opaqueSourceGameId(rawId, policy);
      const recordId = recordIdFor(sourceGameId, ply, fen, policy);
      const candidate = {
        schema: policy.output.schema,
        recordId,
        sourceGameId,
        fen,
        eco,
        openingFamily,
        candidatePly: ply,
        selectionKey: samplingDigest(rawId, policy)
      };
      if (heap.items.length === heap.limit) {
        exclude(exclusions, 'sample-cap-pruned');
      }
      heap.offer(candidate);
    }
  } finally {
    if (ownsRegistry) registry.close();
  }
  const candidates = heap.values();
  counts.retainedForScoring = candidates.length;
  return { candidates, counts, exclusions };
}

function candidateRow(candidate, cpWhite, policy) {
  const row = {
    schema: policy.output.schema,
    recordId: candidate.recordId,
    sourceGameId: candidate.sourceGameId,
    fen: candidate.fen,
    eco: candidate.eco,
    openingFamily: candidate.openingFamily,
    initialBalanceCp: cpWhite
  };
  Freezer.validateCandidate(row, 1);
  return row;
}

async function scoreCandidates(
  extracted, policy, contracts, engine
) {
  assert(extracted && Array.isArray(extracted.candidates) &&
    isObject(extracted.counts) && isObject(extracted.exclusions),
  'extracted candidate state is required');
  assert(contracts && contracts.teacher &&
    contracts.teacher.id === policy.extraction.teacher.id &&
    contracts.teacher.engine.name === policy.extraction.teacher.engine &&
    contracts.teacher.search.nodeLimit ===
      policy.extraction.teacher.nodeLimit,
  'checked-in teacher does not match the opening source policy');
  assert(engine && typeof engine.initialize === 'function' &&
    typeof engine.label === 'function' &&
    typeof engine.quit === 'function',
  'a UciEngine-compatible engine is required');

  const rows = [];
  let closed = false;
  try {
    await engine.initialize(contracts.teacher.uci);
    for (const candidate of extracted.candidates) {
      if (incidentDenied(candidate.fen, contracts)) {
        exclude(extracted.exclusions, 'incident-cluster-or-family');
        continue;
      }
      const parsedFen = Corpus.parseFen4(candidate.fen);
      const turn = parsedFen.turn;
      const result = await engine.label(
        parsedFen.fen4,
        contracts.teacher.search.nodeLimit,
        contracts.teacher.uci
      );
      extracted.counts.scored++;
      const assessment = Label.assessTeacherResult(
        result, turn, contracts.teacher);
      if (!assessment.eligible) {
        exclude(extracted.exclusions, 'teacher-' + assessment.reason);
        continue;
      }
      const cpWhite = assessment.pov.cpWhite;
      if (!Number.isSafeInteger(cpWhite) ||
          Math.abs(cpWhite) >
            policy.extraction.balance.maximumAbsoluteCp) {
        exclude(extracted.exclusions, 'teacher-abs-cp-over-200');
        continue;
      }
      rows.push(candidateRow(candidate, cpWhite, policy));
    }
    await engine.quit();
    closed = true;
  } catch (error) {
    if (!closed && typeof engine.abort === 'function') {
      try { await engine.abort(); } catch (_) {}
    }
    throw error;
  }
  rows.sort(function (left, right) {
    return compareText(left.recordId, right.recordId);
  });
  extracted.counts.outputRows = rows.length;
  return {
    rows,
    counts: extracted.counts,
    exclusions: extracted.exclusions
  };
}

function renderNdjson(rows) {
  assert(Array.isArray(rows), 'candidate rows must be an array');
  let prior = null;
  const lines = rows.map(function (row, index) {
    exactKeys(row, CANDIDATE_KEYS, 'candidate output row');
    Freezer.validateCandidate(row, index + 1);
    assert(OPAQUE_RECORD_ID.test(row.recordId) &&
      OPAQUE_GAME_ID.test(row.sourceGameId),
    'candidate output IDs must be namespaced opaque SHA-256 identities');
    assert(prior == null || compareText(prior, row.recordId) < 0,
      'candidate rows must be in strict recordId order');
    prior = row.recordId;
    return Prepare.stableJson(row);
  });
  return lines.length ? lines.join('\n') + '\n' : '';
}

function validateDependencyHashes(dependencies) {
  const names = [
    'sourcePolicy', 'sourcePolicySchema', 'candidateSchema',
    'sidecarSchema', 'freezeRequestSchema',
    'compiler', 'engine', 'pgn', 'corpus',
    'prepare', 'labelStockfish', 'candidateValidator', 'e4Protocol',
    'teacher', 'heldout', 'heldoutFixture', 'trainingSourcePolicy'
  ];
  exactKeys(dependencies, names, 'dependency hashes');
  names.forEach(function (name) {
    exactKeys(dependencies[name], ['path', 'sha256'],
      'dependency ' + name);
    assert(typeof dependencies[name].path === 'string' &&
      dependencies[name].path.length > 0 &&
      HEX_256.test(dependencies[name].sha256),
    'dependency ' + name + ' is not pinned');
  });
}

function validateSidecar(sidecar, options) {
  const settings = options || {};
  const repositoryRoot = settings.root || ROOT;
  const policy = settings.policy || loadSourcePolicy(path.join(
    repositoryRoot, SOURCE_POLICY_RELATIVE));
  const contracts = settings.contracts || Label.loadFrozenContracts();
  const dependencies = settings.dependencies ||
    dependencyHashes(repositoryRoot);
  validateSourcePolicy(policy);
  validateDependencyHashes(dependencies);

  exactKeys(sidecar, [
    'schema', 'state', 'rawArchive', 'provenance',
    'extraction', 'teacher', 'output'
  ], 'candidate sidecar');
  assert(sidecar.schema === policy.output.sidecarSchema &&
    sidecar.state === 'pinned-opening-candidates',
  'candidate sidecar identity/state drifted');

  const archive = policy.source.archive;
  const expectedRawArchive = {
    id: policy.source.id,
    dataset: policy.source.dataset,
    release: policy.source.release,
    url: archive.url,
    bytes: archive.bytes,
    sha256: archive.sha256,
    compression: archive.compression,
    license: archive.license,
    forbiddenTorrentUrl: policy.source.forbiddenSources[0].url
  };
  assert(Prepare.stableJson(sidecar.rawArchive) ===
    Prepare.stableJson(expectedRawArchive),
  'candidate sidecar raw archive identity drifted');

  const provenanceMap = {
    sourcePolicy: 'sourcePolicy',
    sourcePolicySchema: 'sourcePolicySchema',
    candidateSchema: 'candidateSchema',
    candidateSidecarSchema: 'sidecarSchema',
    freezeRequestSchema: 'freezeRequestSchema',
    compiler: 'compiler',
    engineRules: 'engine',
    pgnParser: 'pgn',
    corpusContract: 'corpus',
    canonicalJsonProducer: 'prepare',
    stockfishAdapter: 'labelStockfish',
    candidateValidator: 'candidateValidator',
    e4ProtocolValidator: 'e4Protocol',
    teacherManifest: 'teacher',
    heldoutManifest: 'heldout',
    heldoutFixture: 'heldoutFixture',
    trainingSourcePolicy: 'trainingSourcePolicy'
  };
  exactKeys(sidecar.provenance,
    ['configurationSha256'].concat(Object.keys(provenanceMap)),
    'candidate sidecar provenance');
  assert(sidecar.provenance.configurationSha256 ===
    configurationSha256(policy),
  'candidate sidecar configuration hash drifted');
  Object.keys(provenanceMap).forEach(function (field) {
    assert(Prepare.stableJson(sidecar.provenance[field]) ===
      Prepare.stableJson(dependencies[provenanceMap[field]]),
    'candidate sidecar provenance mismatch: ' + field);
  });

  exactKeys(sidecar.extraction,
    ['rules', 'counts', 'exclusions'], 'candidate sidecar extraction');
  const expectedRules = {
    filters: policy.filters,
    identity: policy.identity,
    metadata: policy.extraction.metadata,
    candidatePly: policy.extraction.candidatePly,
    sampling: policy.extraction.sampling,
    balance: policy.extraction.balance,
    incidentDenial: policy.extraction.incidentDenial
  };
  assert(Prepare.stableJson(sidecar.extraction.rules) ===
    Prepare.stableJson(expectedRules),
  'candidate sidecar extraction rules drifted');
  exactKeys(sidecar.extraction.counts, Object.keys(newCounts()),
    'candidate sidecar extraction counts');
  Object.keys(sidecar.extraction.counts).forEach(function (field) {
    assert(Number.isSafeInteger(sidecar.extraction.counts[field]) &&
      sidecar.extraction.counts[field] >= 0,
    'candidate sidecar count must be a non-negative safe integer: ' + field);
  });
  const counts = sidecar.extraction.counts;
  assert(counts.sourceFilterEligible <= counts.gamesSeen &&
    counts.hashSampled <= counts.sourceFilterEligible &&
    counts.legalCandidatePositions <= counts.hashSampled &&
    counts.retainedForScoring <= counts.legalCandidatePositions &&
    counts.scored <= counts.retainedForScoring &&
    counts.outputRows <= counts.scored,
  'candidate sidecar extraction count ordering is impossible');
  assert(isObject(sidecar.extraction.exclusions),
    'candidate sidecar exclusions must be an object');
  Object.keys(sidecar.extraction.exclusions).forEach(function (reason) {
    assert(EXCLUSION_REASON_SET.has(reason) &&
      Number.isSafeInteger(sidecar.extraction.exclusions[reason]) &&
      sidecar.extraction.exclusions[reason] > 0,
    'candidate sidecar exclusion reason/count is not registered');
  });
  const exclusions = sidecar.extraction.exclusions;
  const maximumCandidates =
    policy.extraction.sampling.maximumCandidates;
  assert(counts.retainedForScoring <= maximumCandidates &&
    counts.scored <= maximumCandidates &&
    counts.outputRows <= maximumCandidates,
  'candidate sidecar exceeds the frozen candidate cap');
  assert(counts.gamesSeen === counts.sourceFilterEligible +
      exclusionTotal(exclusions, BEFORE_SOURCE_ELIGIBLE_REASONS) &&
    counts.sourceFilterEligible === counts.hashSampled +
      (exclusions['hash-sample-rejected'] || 0) &&
    counts.hashSampled === counts.legalCandidatePositions +
      exclusionTotal(exclusions, BEFORE_LEGAL_POSITION_REASONS) &&
    counts.legalCandidatePositions === counts.retainedForScoring +
      (exclusions['sample-cap-pruned'] || 0) &&
    counts.retainedForScoring === counts.scored &&
    counts.scored === counts.outputRows +
      exclusionTotal(exclusions, TEACHER_EXCLUSION_REASONS),
  'candidate sidecar count/exclusion ledger is inconsistent');

  exactKeys(sidecar.teacher, [
    'id', 'name', 'release', 'sourceCommit', 'manifestSha256',
    'expectedExecutableSha256', 'actualExecutableSha256', 'nodeLimit',
    'options', 'networks', 'results'
  ], 'candidate sidecar teacher');
  const teacher = contracts.teacher;
  assert(sidecar.teacher.id === teacher.id &&
    sidecar.teacher.name === teacher.engine.name &&
    sidecar.teacher.release === teacher.engine.release &&
    sidecar.teacher.sourceCommit === teacher.engine.sourceCommit &&
    sidecar.teacher.manifestSha256 === contracts.teacherSha256 &&
    sidecar.teacher.expectedExecutableSha256 ===
      teacher.engine.executable.sha256 &&
    sidecar.teacher.actualExecutableSha256 ===
      teacher.engine.executable.sha256 &&
    sidecar.teacher.nodeLimit === teacher.search.nodeLimit &&
    Prepare.stableJson(sidecar.teacher.options) ===
      Prepare.stableJson(teacher.uci),
  'candidate sidecar teacher identity/gate drifted');
  const expectedNetworks = teacher.engine.networks.map(function (network) {
    return {
      option: network.option,
      embeddedName: network.embeddedName,
      sha256: network.sha256
    };
  });
  assert(Prepare.stableJson(sidecar.teacher.networks) ===
    Prepare.stableJson(expectedNetworks),
  'candidate sidecar ordered teacher network identity drifted');
  exactKeys(sidecar.teacher.results,
    ['scoredPositions', 'eligibleRows', 'excludedAfterScoring'],
    'candidate sidecar teacher results');
  assert(sidecar.teacher.results.scoredPositions === counts.scored &&
    sidecar.teacher.results.eligibleRows === counts.outputRows &&
    sidecar.teacher.results.excludedAfterScoring ===
      counts.scored - counts.outputRows,
  'candidate sidecar teacher result accounting drifted');

  exactKeys(sidecar.output, [
    'path', 'schema', 'format', 'order', 'rows', 'bytes', 'sha256'
  ], 'candidate sidecar output');
  assert(validArtifactBasename(sidecar.output.path) &&
    path.basename(sidecar.output.path) === sidecar.output.path &&
    sidecar.output.schema === policy.output.schema &&
    sidecar.output.format === policy.output.format &&
    sidecar.output.order === policy.output.order &&
    sidecar.output.rows === counts.outputRows &&
    Number.isSafeInteger(sidecar.output.bytes) &&
    sidecar.output.bytes >= 0 &&
    HEX_256.test(sidecar.output.sha256 || ''),
  'candidate sidecar output identity/accounting drifted');
  if (settings.outputPath !== undefined) {
    assert(sidecar.output.path === path.basename(settings.outputPath),
      'candidate sidecar output path does not match');
  }
  if (settings.outputBytes !== undefined) {
    const bytes = Buffer.isBuffer(settings.outputBytes) ?
      settings.outputBytes : Buffer.from(String(settings.outputBytes));
    assert(sidecar.output.bytes === bytes.length &&
      sidecar.output.sha256 === sha256(bytes),
    'candidate sidecar does not bind the supplied output bytes');
    const text = bytes.toString('utf8');
    assert((sidecar.output.rows === 0 && text === '') ||
      (text.endsWith('\n') &&
        text.slice(0, -1).split('\n').length === sidecar.output.rows),
    'candidate sidecar output row count does not match its bytes');
  }
  return true;
}

function buildSidecar(options) {
  const policy = options.policy;
  const contracts = options.contracts;
  const dependencies = options.dependencies;
  const outputBytes = options.outputBytes;
  const outputPath = options.outputPath;
  const actualExecutableSha256 = options.actualExecutableSha256;
  const result = options.result;
  validateSourcePolicy(policy);
  validateDependencyHashes(dependencies);
  assert(contracts && contracts.teacher &&
    contracts.teacherSha256 === dependencies.teacher.sha256 &&
    contracts.heldoutSha256 === dependencies.heldout.sha256,
  'sidecar contract hashes disagree with checked-in contracts');
  assert(actualExecutableSha256 ===
    contracts.teacher.engine.executable.sha256,
  'actual Stockfish executable hash does not match the teacher pin');
  assert(typeof outputBytes === 'string' &&
    result && Array.isArray(result.rows) &&
    result.rows.length === result.counts.outputRows,
  'sidecar output accounting is invalid');
  const outputSha256 = sha256(outputBytes);
  const archive = policy.source.archive;
  const sidecar = {
    schema: policy.output.sidecarSchema,
    state: 'pinned-opening-candidates',
    rawArchive: {
      id: policy.source.id,
      dataset: policy.source.dataset,
      release: policy.source.release,
      url: archive.url,
      bytes: archive.bytes,
      sha256: archive.sha256,
      compression: archive.compression,
      license: archive.license,
      forbiddenTorrentUrl: policy.source.forbiddenSources[0].url
    },
    provenance: {
      sourcePolicy: dependencies.sourcePolicy,
      sourcePolicySchema: dependencies.sourcePolicySchema,
      candidateSchema: dependencies.candidateSchema,
      candidateSidecarSchema: dependencies.sidecarSchema,
      freezeRequestSchema: dependencies.freezeRequestSchema,
      configurationSha256: configurationSha256(policy),
      compiler: dependencies.compiler,
      engineRules: dependencies.engine,
      pgnParser: dependencies.pgn,
      corpusContract: dependencies.corpus,
      canonicalJsonProducer: dependencies.prepare,
      stockfishAdapter: dependencies.labelStockfish,
      candidateValidator: dependencies.candidateValidator,
      e4ProtocolValidator: dependencies.e4Protocol,
      teacherManifest: dependencies.teacher,
      heldoutManifest: dependencies.heldout,
      heldoutFixture: dependencies.heldoutFixture,
      trainingSourcePolicy: dependencies.trainingSourcePolicy
    },
    extraction: {
      rules: {
        filters: jsonClone(policy.filters),
        identity: jsonClone(policy.identity),
        metadata: jsonClone(policy.extraction.metadata),
        candidatePly: jsonClone(policy.extraction.candidatePly),
        sampling: jsonClone(policy.extraction.sampling),
        balance: jsonClone(policy.extraction.balance),
        incidentDenial: policy.extraction.incidentDenial
      },
      counts: jsonClone(result.counts),
      exclusions: jsonClone(result.exclusions)
    },
    teacher: {
      id: contracts.teacher.id,
      name: contracts.teacher.engine.name,
      release: contracts.teacher.engine.release,
      sourceCommit: contracts.teacher.engine.sourceCommit,
      manifestSha256: contracts.teacherSha256,
      expectedExecutableSha256:
        contracts.teacher.engine.executable.sha256,
      actualExecutableSha256,
      nodeLimit: contracts.teacher.search.nodeLimit,
      options: jsonClone(contracts.teacher.uci),
      networks: contracts.teacher.engine.networks.map(function (network) {
        return {
          option: network.option,
          embeddedName: network.embeddedName,
          sha256: network.sha256
        };
      }),
      results: {
        scoredPositions: result.counts.scored,
        eligibleRows: result.rows.length,
        excludedAfterScoring:
          result.counts.scored - result.rows.length
      }
    },
    output: {
      path: path.basename(outputPath),
      schema: policy.output.schema,
      format: policy.output.format,
      order: policy.output.order,
      rows: result.rows.length,
      bytes: Buffer.byteLength(outputBytes),
      sha256: outputSha256
    }
  };
  validateSidecar(sidecar, {
    policy,
    contracts,
    dependencies,
    outputBytes,
    outputPath
  });
  return sidecar;
}

function refuseExistingArtifacts(outputPath) {
  const sidecarPath = outputPath + '.manifest.json';
  const existing = [outputPath, sidecarPath].filter(function (filename) {
    return fs.existsSync(filename);
  });
  assert(existing.length === 0,
    'refusing to overwrite output artifact: ' + existing.join(', '));
  return sidecarPath;
}

function writeArtifacts(outputPath, outputBytes, sidecar) {
  const resolved = path.resolve(outputPath);
  const sidecarPath = refuseExistingArtifacts(resolved);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  assert(sidecar && sidecar.output &&
    sidecar.output.path === path.basename(resolved) &&
    sidecar.output.bytes === Buffer.byteLength(outputBytes) &&
    sidecar.output.sha256 === sha256(outputBytes),
  'sidecar does not bind the exact candidate output bytes');
  const sidecarBytes = Prepare.stableJson(sidecar) + '\n';
  const created = [];
  try {
    fs.writeFileSync(resolved, outputBytes, { flag: 'wx' });
    created.push(resolved);
    fs.writeFileSync(sidecarPath, sidecarBytes, { flag: 'wx' });
    created.push(sidecarPath);
  } catch (error) {
    created.forEach(function (filename) {
      try { fs.unlinkSync(filename); } catch (_) {}
    });
    throw error;
  }
  return { output: resolved, sidecar: sidecarPath };
}

function parseArgs(argv) {
  const allowed = new Set(['input', 'output', 'stockfish']);
  const out = {};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    assert(/^--/.test(token), 'unexpected argument: ' + token);
    const name = token.slice(2);
    assert(allowed.has(name), 'unknown or frozen argument: --' + name);
    assert(!Object.prototype.hasOwnProperty.call(out, name),
      'duplicate argument: --' + name);
    assert(index + 1 < argv.length && !/^--/.test(argv[index + 1]),
      '--' + name + ' requires a value');
    out[name] = argv[++index];
  }
  allowed.forEach(function (name) {
    assert(typeof out[name] === 'string' && out[name],
      '--' + name + ' is required');
  });
  return out;
}

async function extractCandidatesFromFile(
  filename, policy, contracts, options
) {
  const source = openPgnSource(
    filename, policy.source.archive.compression,
    options && options.spawnImpl,
    options && options.authenticatedInput);
  // Attach the rejection handler before consuming stdout. A corrupt archive
  // can make zstd exit while the parser is still draining already-emitted
  // bytes; delaying the handler until after parsing would create a transient
  // unhandled rejection.
  const completion = source.done.then(function () {
    return null;
  }, function (error) {
    return error;
  });
  try {
    const extracted = await extractCandidates(
      source.stream, policy, { contracts });
    const sourceError = await completion;
    if (sourceError) throw sourceError;
    if (options && options.authenticatedInput) {
      options.authenticatedInput.assertUnchanged();
    }
    return extracted;
  } catch (error) {
    if (source.rawInput) source.rawInput.destroy();
    if (source.child && !source.child.killed) {
      source.child.kill('SIGKILL');
    }
    await completion;
    throw error;
  }
}

async function run(argv, root) {
  const args = parseArgs(argv);
  const repositoryRoot = root || ROOT;
  const outputPath = path.resolve(args.output);
  assert(validArtifactBasename(path.basename(outputPath)),
    '--output basename must not contain slashes, backslashes, or controls');
  refuseExistingArtifacts(outputPath);

  // Capture every mutation-relevant byte before authenticating the 28 GB
  // archive. The same set is rehashed after extraction and immediately before
  // publication so a long-running compiler cannot silently mix revisions.
  const dependencies = dependencyHashes(repositoryRoot);
  const policyPath = path.join(
    repositoryRoot, SOURCE_POLICY_RELATIVE);
  const policyArtifact = loadSourcePolicyArtifact(policyPath);
  assert(dependencies.sourcePolicy.sha256 === policyArtifact.sha256,
    'source policy changed while preparing provenance');
  const policy = policyArtifact.policy;
  const contracts = Label.loadFrozenContracts();
  const authenticatedInput = await authenticateInputFile(
    path.resolve(args.input), policy.source.archive);
  let verifiedExecutable = null;
  try {
    const extracted = await extractCandidatesFromFile(
      authenticatedInput.filename, policy, contracts, {
        authenticatedInput
      });
    authenticatedInput.close();
    assertDependencyHashesUnchanged(dependencies, repositoryRoot);
    // Authenticate/copy immediately before spawning, rather than leaving even
    // the private executable staged during the long archive scan.
    verifiedExecutable = prepareVerifiedExecutable(
      path.resolve(args.stockfish),
      contracts.teacher.engine.executable.sha256);
    const actualExecutableSha256 = verifiedExecutable.sha256;
    const engine = createPinnedEngine(verifiedExecutable, contracts);
    const result = await scoreCandidates(
      extracted, policy, contracts, engine);
    const outputBytes = renderNdjson(result.rows);
    const sidecar = buildSidecar({
      policy,
      contracts,
      dependencies,
      outputBytes,
      outputPath,
      actualExecutableSha256,
      result
    });
    assertDependencyHashesUnchanged(dependencies, repositoryRoot);
    const artifacts = writeArtifacts(
      outputPath, outputBytes, sidecar);
    return {
      output: artifacts.output,
      sidecar: artifacts.sidecar,
      rows: result.rows.length,
      sha256: sidecar.output.sha256,
      counts: result.counts,
      exclusions: result.exclusions
    };
  } finally {
    authenticatedInput.close();
    if (verifiedExecutable) verifiedExecutable.cleanup();
  }
}

module.exports = Object.freeze({
  ROOT,
  SOURCE_POLICY_PATH,
  CANDIDATE_KEYS,
  EXCLUSION_REASONS,
  validateSourcePolicy,
  loadSourcePolicyArtifact,
  loadSourcePolicy,
  configurationSha256,
  dependencyHashes,
  assertDependencyHashesUnchanged,
  fileSha256,
  authenticateInputFile,
  verifyInputFile,
  prepareVerifiedExecutable,
  createPinnedEngine,
  openPgnSource,
  splitPgnGames,
  leadingTags,
  gameIdFromTags,
  encodeGameId,
  DiskGameIdRegistry,
  MemoryGameIdRegistry,
  candidatePly,
  samplingDigest,
  sampleAccepted,
  opaqueSourceGameId,
  recordIdFor,
  filterReason,
  replayToPly,
  incidentDenied,
  BoundedCandidateHeap,
  extractCandidates,
  scoreCandidates,
  renderNdjson,
  validateSidecar,
  buildSidecar,
  refuseExistingArtifacts,
  writeArtifacts,
  parseArgs,
  extractCandidatesFromFile,
  run
});

if (require.main === module) {
  run(process.argv.slice(2)).then(function (summary) {
    console.log(JSON.stringify(summary, null, 2));
  }).catch(function (error) {
    console.error('prepare-e4-opening-candidates: ' + error.message);
    process.exitCode = 1;
  });
}
