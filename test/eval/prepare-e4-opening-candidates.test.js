#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const Compiler = require('./prepare-e4-opening-candidates.js');
const Label = require('../training/label-stockfish.js');
const Corpus = require('../training/corpus.js');

const policy = Compiler.loadSourcePolicy();
const contracts = Label.loadFrozenContracts();
const LONG_MOVES =
  '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 ' +
  '5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O ' +
  '9. h3 Nb8 10. d4 Nbd7 11. c4 c6 12. Nc3 Qc7 13. Be3';
const MATE_AT_12 =
  '1. Nc3 e5 2. Nb1 Nc6 3. Nc3 Nb8 4. Nb1 Nc6 ' +
  '5. f3 Nb8 6. g4 Qh4#';

let checks = 0;
function equal(actual, expected, message) {
  assert.deepStrictEqual(actual, expected, message);
  checks++;
}
function ok(value, message) {
  assert.ok(value, message);
  checks++;
}
function throws(callback, pattern, message) {
  assert.throws(callback, pattern, message);
  checks++;
}
async function rejects(callback, pattern, message) {
  await assert.rejects(callback, pattern, message);
  checks++;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function base62Id(value) {
  const alphabet =
    '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let id = '';
  let remaining = value;
  for (let index = 0; index < 8; index++) {
    id = alphabet[remaining % alphabet.length] + id;
    remaining = Math.floor(remaining / alphabet.length);
  }
  return id;
}

function findId(options) {
  const wantedPly = options && options.ply;
  let value = options && options.start || 1;
  for (;;) {
    const id = base62Id(value++);
    if (Compiler.sampleAccepted(id, policy) &&
        (wantedPly == null ||
          Compiler.candidatePly(id, policy) === wantedPly)) {
      return id;
    }
  }
}

function pgn(id, options) {
  const settings = options || {};
  const result = settings.result || '*';
  const tags = [
    ['Event', settings.event || 'Rated Rapid game'],
    ['Site', settings.site || 'https://lichess.org/' + id],
    ['Date', '2026.06.15'],
    ['Round', '-'],
    ['White', settings.white || 'AliceUnique'],
    ['Black', settings.black || 'BobUnique'],
    ['Result', result],
    ['WhiteElo', settings.whiteElo || '2100'],
    ['BlackElo', settings.blackElo || '2050']
  ];
  if (settings.whiteTitle != null) {
    tags.push(['WhiteTitle', settings.whiteTitle]);
  }
  if (settings.blackTitle != null) {
    tags.push(['BlackTitle', settings.blackTitle]);
  }
  if (settings.variant != null) tags.push(['Variant', settings.variant]);
  if (settings.setup != null) tags.push(['SetUp', settings.setup]);
  if (settings.fen != null) tags.push(['FEN', settings.fen]);
  if (settings.eco !== null) tags.push(['ECO', settings.eco || 'C60']);
  if (settings.opening !== null) {
    tags.push(['Opening', settings.opening || 'Ruy Lopez']);
  }
  tags.push(['TimeControl', '600+0']);
  const header = tags.map(function (entry) {
    return '[' + entry[0] + ' "' + entry[1] + '"]';
  }).join('\n');
  return header + '\n\n' +
    (settings.moves || LONG_MOVES) + ' ' + result + '\n';
}

function byteChunks(text) {
  const bytes = Buffer.from(text, 'utf8');
  const sizes = [1, 2, 7, 3, 31, 5, 97, 11];
  const chunks = [];
  let offset = 0;
  let cursor = 0;
  while (offset < bytes.length) {
    const size = sizes[cursor++ % sizes.length];
    chunks.push(bytes.subarray(offset, Math.min(bytes.length, offset + size)));
    offset += size;
  }
  return chunks;
}

function firstLegalUci(fen) {
  const state = Chess.newGameState(fen);
  const move = Chess.legalMoves(state)[0];
  return Chess.sqName(move.from) + Chess.sqName(move.to) +
    (move.promotion ? move.promotion.toLowerCase() : '');
}

function exactResult(fen, cpWhite) {
  const turn = fen.split(/\s+/)[1];
  const cpSideToMove = turn === 'w' ? cpWhite : -cpWhite;
  const wdlWhite = [350, 500, 150];
  const wdlSideToMove = turn === 'w' ?
    wdlWhite : [wdlWhite[2], wdlWhite[1], wdlWhite[0]];
  const bestMove = firstLegalUci(fen);
  const info = {
    depth: 15,
    seldepth: 19,
    cpSideToMove,
    wdlSideToMove,
    nodes: 100000,
    pvUci: [bestMove]
  };
  return { info, terminalInfo: info, bestMove };
}

function mateResult(fen) {
  const bestMove = firstLegalUci(fen);
  const info = {
    depth: 18,
    seldepth: 22,
    mateSideToMove: 3,
    nodes: 100000,
    pvUci: [bestMove]
  };
  return { info, terminalInfo: info, bestMove };
}

function boundResult(fen) {
  const result = exactResult(fen, 20);
  result.info.scoreBound = 'lowerbound';
  return result;
}

class FakeEngine {
  constructor(handler) {
    this.handler = handler || function (fen) {
      return exactResult(fen, 30);
    };
    this.calls = [];
    this.initialized = false;
    this.quitCalled = false;
    this.abortCalled = false;
  }

  async initialize(uci) {
    equal(uci.UCI_ShowWDL, true,
      'fake observes the pinned WDL-enabled UCI contract');
    this.initialized = true;
  }

  async label(fen, nodes) {
    equal(nodes, 100000,
      'every candidate uses the pinned 100k-node teacher gate');
    this.calls.push(fen);
    return this.handler(fen, this.calls.length - 1);
  }

  async quit() {
    this.quitCalled = true;
  }

  async abort() {
    this.abortCalled = true;
  }
}

async function collectGames(chunks) {
  const games = [];
  for await (const game of Compiler.splitPgnGames(chunks)) games.push(game);
  return games;
}

async function extract(text) {
  return Compiler.extractCandidates(
    byteChunks(text), policy, {
      contracts,
      registry: new Compiler.MemoryGameIdRegistry()
    });
}

async function main() {
  equal(policy.source.archive.url,
    'https://database.lichess.org/standard/' +
      'lichess_db_standard_rated_2026-06.pgn.zst',
  'source policy pins the official direct June archive');
  equal(policy.source.archive.bytes, 28241946492);
  equal(policy.source.archive.sha256,
    '8fd81071f56511e7546cb77e38db5cf32f7e8a437fb906e26959cc064d8b1f79');
  equal(policy.source.archive.license, 'CC0-1.0');
  equal(policy.source.id, 'lichess-standard-rated-pgn');
  equal(policy.filters.ratedSpeeds,
    ['Blitz', 'Rapid', 'Classical']);
  equal(policy.filters.ratedEventKinds,
    ['game', 'tournament', 'swiss']);
  equal(policy.extraction.metadata, {
    eco: 'trimmed-[A-E][0-9]{2}',
    openingFamily: 'NFC-trimmed-prefix-before-first-colon',
    maximumOpeningCharacters: 256
  }, 'opening lineage metadata normalization is pinned');
  equal(policy.source.forbiddenSources[0], {
    url: policy.source.archive.url + '.torrent',
    accepted: false,
    reason: 'stale-torrent-metadata-is-not-source-evidence'
  }, 'the stale torrent is an explicit negative allowlist entry');

  const mutatedUrl = JSON.parse(JSON.stringify(policy));
  mutatedUrl.source.archive.url = policy.source.forbiddenSources[0].url;
  throws(function () {
    Compiler.validateSourcePolicy(mutatedUrl);
  }, /official direct June 2026 archive pin drifted/,
  'the torrent cannot be substituted for the direct archive');
  const mutatedFilter = JSON.parse(JSON.stringify(policy));
  mutatedFilter.filters.minimumElo = 1799;
  throws(function () {
    Compiler.validateSourcePolicy(mutatedFilter);
  }, /fixed source filters drifted/);
  const mutableTeacher = JSON.parse(JSON.stringify(policy));
  mutableTeacher.extraction.teacher.nodeLimit = 99999;
  throws(function () {
    Compiler.validateSourcePolicy(mutableTeacher);
  }, /pinned teacher policy drifted/);
  const extraKey = JSON.parse(JSON.stringify(policy));
  extraKey.filters.posthoc = true;
  throws(function () {
    Compiler.validateSourcePolicy(extraKey);
  }, /must contain exactly/);
  throws(function () {
    Compiler.parseArgs([
      '--input', 'a', '--output', 'b', '--stockfish', 'c',
      '--nodes', '1'
    ]);
  }, /unknown or frozen argument/,
  'node budget cannot be overridden from the CLI');

  let spawnCall = null;
  const fakeChild = new EventEmitter();
  fakeChild.stdout = new PassThrough();
  fakeChild.stderr = new PassThrough();
  fakeChild.killed = false;
  fakeChild.kill = function () {
    fakeChild.killed = true;
  };
  const compressed = Compiler.openPgnSource(
    '/tmp/pinned-input.pgn.zst', 'zstd',
    function (command, args, options) {
      spawnCall = { command, args, options };
      return fakeChild;
    });
  equal(spawnCall.command, 'zstd');
  equal(spawnCall.args, [
    '-dc', '--', '/tmp/pinned-input.pgn.zst'
  ], 'compressed input uses literal zstd -dc with no shell');
  fakeChild.stdout.end('truncated');
  fakeChild.stderr.end('unexpected end of file');
  queueMicrotask(function () {
    fakeChild.emit('close', 1, null);
  });
  await rejects(function () {
    return compressed.done;
  }, /truncated or corrupt/,
  'a nonzero zstd status makes truncated input fail closed');

  const boundedHeap = new Compiler.BoundedCandidateHeap(2);
  boundedHeap.offer({ selectionKey: 'c', recordId: '3' });
  boundedHeap.offer({ selectionKey: 'a', recordId: '1' });
  boundedHeap.offer({ selectionKey: 'b', recordId: '2' });
  equal(boundedHeap.values().map(function (candidate) {
    return candidate.selectionKey;
  }), ['a', 'b'],
  'bounded overflow retains the deterministic lowest full digests');

  const caseUpper = 'AbCd1234';
  const caseLower = 'abcd1234';
  ok(Compiler.opaqueSourceGameId(caseUpper, policy) !==
      Compiler.opaqueSourceGameId(caseLower, policy),
  'case-sensitive Lichess IDs remain distinct before opaque hashing');
  throws(function () {
    Compiler.gameIdFromTags({
      Site: 'https://lichess.org/AbCd1234/black'
    }, policy);
  }, /case-sensitive 8-character/,
  'Site suffixes are not accepted as raw game IDs');

  const diskRegistry = new Compiler.DiskGameIdRegistry();
  const diskRegistryDirectory = diskRegistry.directory;
  diskRegistry.add(caseUpper);
  diskRegistry.add(caseLower);
  throws(function () {
    diskRegistry.add(caseUpper);
  }, /duplicate case-sensitive Lichess game ID/,
  'production disk registry rejects an exact duplicate game ID');
  diskRegistry.close();
  ok(!fs.existsSync(diskRegistryDirectory),
    'production disk registry removes its temporary database');

  const ids = [
    findId({ start: 100 }),
    findId({ start: 10000 }),
    findId({ start: 20000 })
  ];
  ok(new Set(ids).size === ids.length,
    'test games have distinct sampled identities');
  const games = ids.map(function (id, index) {
    return pgn(id, {
      event: index === 1 ?
        'Rated Blitz tournament https://lichess.org/tournament/AbCd1234' :
        'Rated Rapid game',
      white: index === 0 ? 'JoséUnique' : 'AliceUnique' + index,
      black: 'BobUnique' + index,
      opening: index === 0 ? 'Réti Opening' :
        index === 2 ? 'Ruy Lopez: Berlin Defense' : 'Ruy Lopez'
    });
  });
  const archive = games.join('\n\n');

  const split = await collectGames(byteChunks(archive));
  equal(split.length, games.length,
    'PGN game splitting survives arbitrary byte/chunk boundaries');
  split.forEach(function (game, index) {
    const parsed = ChessyPGN.parseGame(game);
    ok(parsed.valid && parsed.plies >= 20,
      'chunked game ' + index + ' remains a legal PGN');
  });

  const firstExtraction = await extract(archive);
  const secondExtraction = await Compiler.extractCandidates(
    [Buffer.from(archive)], policy, {
      contracts,
      registry: new Compiler.MemoryGameIdRegistry()
    });
  equal(firstExtraction, secondExtraction,
    'candidate extraction is byte-for-byte deterministic across chunking');
  equal(firstExtraction.candidates.length, ids.length);
  equal(firstExtraction.counts.hashSampled, ids.length);
  equal(firstExtraction.counts.legalCandidatePositions, ids.length);

  const shadowId = findId({ start: 25000 });
  const shadowMoves = LONG_MOVES.replace(
    '1. e4 e5',
    '1. e4 { [Site "https://lichess.org/ZZZZZZZZ"] ' +
      '[ECO "A00"] [Opening "Shadow"] } e5');
  const shadow = await extract(pgn(shadowId, {
    moves: shadowMoves
  }));
  equal(shadow.candidates.length, 1,
    'tag-shaped movetext cannot replace leading identity metadata');
  equal(shadow.candidates[0].sourceGameId,
    Compiler.opaqueSourceGameId(shadowId, policy));
  equal(shadow.candidates[0].eco, 'C60');
  equal(shadow.candidates[0].openingFamily, 'Ruy Lopez');

  ids.forEach(function (id, index) {
    const sourceGameId = Compiler.opaqueSourceGameId(id, policy);
    const candidate = firstExtraction.candidates.find(function (entry) {
      return entry.sourceGameId === sourceGameId;
    });
    ok(candidate, 'opaque lineage preserves one candidate per source game');
    const parsed = ChessyPGN.parseGame(games[index]);
    const ply = Compiler.candidatePly(id, policy);
    const expected = Compiler.replayToPly(parsed, ply);
    equal(candidate.candidatePly, ply,
      'candidate ply is the fixed game-ID hash selection');
    equal(candidate.fen,
      Corpus.validateSourceState(Chess.toFen(expected)).fen6,
    'candidate FEN retains canonical six-field replay state at the selected ply');
    equal(candidate.openingFamily,
      index === 0 ? 'Réti Opening' : 'Ruy Lopez',
    'Opening subvariation text is deterministically reduced to its family');
    equal(Chess.gameStatus(expected).over, false);
  });

  const goodEngine = new FakeEngine();
  const good = await Compiler.scoreCandidates(
    firstExtraction, policy, contracts, goodEngine);
  equal(good.rows.length, ids.length);
  equal(goodEngine.calls.length, ids.length);
  ok(goodEngine.calls.every(function (fen) {
    return fen.trim().split(/\s+/).length === 4;
  }), 'the existing UciEngine receives FEN4 because it appends 0 1 itself');
  equal(goodEngine.quitCalled, true);
  good.rows.forEach(function (row, index) {
    equal(Object.keys(row).sort(), Compiler.CANDIDATE_KEYS.slice().sort(),
      'output row uses the strict current candidate schema');
    if (index) {
      ok(good.rows[index - 1].recordId.localeCompare(row.recordId) < 0,
        'output rows use canonical recordId order');
    }
    equal(row.initialBalanceCp, 30,
      'Stockfish side-to-move scores are stored in White POV');
    equal(row.fen.trim().split(/\s+/).length, 6,
      'candidate output preserves validated move counters');
    ok(/^chessy\.e4\.lichess-standard-rated\.2026-06:game:[0-9a-f]{64}$/
      .test(row.sourceGameId),
    'source game lineage is namespaced and SHA-256 opaque');
  });
  const outputBytes = Compiler.renderNdjson(good.rows);
  [
    ...ids,
    'JoséUnique',
    'AliceUnique',
    'BobUnique',
    'https://lichess.org/',
    'WhiteElo',
    'BlackElo'
  ].forEach(function (secret) {
    ok(!outputBytes.includes(secret),
      'candidate NDJSON contains no raw ID, URL, username, or rating tag');
  });
  equal(Compiler.renderNdjson(good.rows), outputBytes,
    'canonical NDJSON rendering is stable');

  const duplicateId = base62Id(777);
  await rejects(function () {
    return extract([
      pgn(duplicateId),
      pgn(duplicateId, { white: 'DifferentPlayer' })
    ].join('\n\n'));
  }, /duplicate case-sensitive Lichess game ID/,
  'duplicate raw game IDs fail the whole compilation');
  await rejects(function () {
    return extract(pgn('unused00', {
      site: 'https://lichess.org/not-8-chars'
    }));
  }, /case-sensitive 8-character/,
  'malformed raw game IDs fail the whole compilation');

  const missing = await extract([
    pgn(base62Id(801), { eco: null }),
    pgn(base62Id(802), { opening: null })
  ].join('\n\n'));
  equal(missing.candidates.length, 0);
  equal(missing.exclusions['missing-or-invalid-eco'], 1);
  equal(missing.exclusions['missing-or-invalid-opening'], 1);

  const filtered = await extract([
    pgn(base62Id(810), { whiteTitle: 'BOT' }),
    pgn(base62Id(811), { black: 'AliceUnique' }),
    pgn(base62Id(812), { whiteElo: '1799' }),
    pgn(base62Id(813), { event: 'Casual Rapid game' }),
    pgn(base62Id(814), { variant: 'Chess960' })
  ].join('\n\n'));
  equal(filtered.candidates.length, 0);
  equal(filtered.exclusions['bot-player'], 1);
  equal(filtered.exclusions['self-play'], 1);
  equal(filtered.exclusions['elo-below-minimum-or-missing'], 1);
  equal(filtered.exclusions['ineligible-event'], 1);
  equal(filtered.exclusions['nonstandard-initial-position'], 1);

  const terminalId = findId({ ply: 12, start: 30000 });
  const terminalGame = pgn(terminalId, {
    moves: MATE_AT_12,
    result: '0-1',
    eco: 'A00',
    opening: 'Van Geet Opening'
  });
  const terminalParsed = ChessyPGN.parseGame(terminalGame);
  ok(terminalParsed.valid && terminalParsed.plies === 12,
    'terminal fixture is a legal twelve-ply checkmate');
  const terminal = await extract(terminalGame);
  equal(terminal.candidates.length, 0);
  equal(terminal.exclusions['terminal-candidate-position'], 1,
    'terminal selected positions are rejected before scoring');

  equal(Compiler.incidentDenied(
    contracts.heldout.incident.fen, contracts), true,
  'the exact incident position is denied');
  let incidentAfterMove = Chess.newGameState(
    contracts.heldout.incident.fen);
  const incidentMove = Chess.legalMoves(incidentAfterMove).find(
    function (move) {
      return Chess.sqName(move.from) + Chess.sqName(move.to) === 'c5d4';
    });
  ok(incidentMove, 'incident family variant has the recorded legal move');
  incidentAfterMove = Chess.playMove(incidentAfterMove, incidentMove);
  const familyVariantFen = Chess.toFen(incidentAfterMove);
  ok(Compiler.incidentDenied(familyVariantFen, contracts),
    'the broader incident position family is denied independently');
  const incidentCandidate = {
    schema: policy.output.schema,
    recordId: 'incident-record',
    sourceGameId: 'incident-game',
    fen: contracts.heldout.incident.fen,
    eco: 'A00',
    openingFamily: 'denied',
    candidatePly: 20,
    selectionKey: '0'.repeat(64)
  };
  const incidentEngine = new FakeEngine();
  const incidentResult = await Compiler.scoreCandidates({
    candidates: [incidentCandidate],
    counts: {
      gamesSeen: 1,
      sourceFilterEligible: 1,
      hashSampled: 1,
      legalCandidatePositions: 1,
      retainedForScoring: 1,
      scored: 0,
      outputRows: 0
    },
    exclusions: {}
  }, policy, contracts, incidentEngine);
  equal(incidentEngine.calls.length, 0,
    'incident cluster/family denial happens before the teacher call');
  equal(incidentResult.exclusions['incident-cluster-or-family'], 1);

  const rejectionEngine = new FakeEngine(function (fen, index) {
    if (index === 0) return mateResult(fen);
    if (index === 1) return exactResult(fen, 201);
    return boundResult(fen);
  });
  const rejectionExtraction = await extract(archive);
  const rejected = await Compiler.scoreCandidates(
    rejectionExtraction, policy, contracts, rejectionEngine);
  equal(rejected.rows.length, 0);
  equal(rejected.exclusions['teacher-mate-score'], 1);
  equal(rejected.exclusions['teacher-abs-cp-over-200'], 1);
  equal(rejected.exclusions['teacher-bound-score'], 1,
    'bounded scores remain ineligible under the existing assessment');

  const temporary = fs.mkdtempSync(path.join(
    os.tmpdir(), 'chessy-e4-compiler-test-'));
  try {
    const input = path.join(temporary, 'synthetic.pgn');
    fs.writeFileSync(input, archive);
    const identity = {
      bytes: Buffer.byteLength(archive),
      sha256: sha256(archive)
    };
    equal(await Compiler.verifyInputFile(input, identity), identity,
      'full uncompressed synthetic input size and hash verify');
    await rejects(function () {
      return Compiler.verifyInputFile(input, {
        bytes: identity.bytes + 1,
        sha256: identity.sha256
      });
    }, /byte size/);
    await rejects(function () {
      return Compiler.verifyInputFile(input, {
        bytes: identity.bytes,
        sha256: '0'.repeat(64)
      });
    }, /SHA-256/);

    const authenticated = await Compiler.authenticateInputFile(
      input, identity);
    let authenticatedSpawn = null;
    const descriptorChild = new EventEmitter();
    descriptorChild.stdin = new PassThrough();
    descriptorChild.stdout = new PassThrough();
    descriptorChild.stderr = new PassThrough();
    descriptorChild.killed = false;
    descriptorChild.kill = function () {
      descriptorChild.killed = true;
    };
    descriptorChild.stdin.on('data', function (chunk) {
      descriptorChild.stdout.write(chunk);
    });
    descriptorChild.stdin.on('end', function () {
      descriptorChild.stdout.end();
      descriptorChild.stderr.end();
      queueMicrotask(function () {
        descriptorChild.emit('close', 0, null);
      });
    });
    const descriptorSource = Compiler.openPgnSource(
      input, 'zstd', function (command, args, options) {
        authenticatedSpawn = { command, args, options };
        return descriptorChild;
      }, authenticated);
    const descriptorOutput = [];
    for await (const chunk of descriptorSource.stream) {
      descriptorOutput.push(chunk);
    }
    await descriptorSource.done;
    equal(authenticatedSpawn.command, 'zstd');
    equal(authenticatedSpawn.args, ['-dc'],
      'production zstd reads the already-authenticated descriptor on stdin');
    equal(Buffer.concat(descriptorOutput).toString('utf8'), archive,
      'descriptor-backed decompression consumes the authenticated bytes');
    authenticated.assertUnchanged();

    const originalPath = input + '.authenticated-original';
    fs.renameSync(input, originalPath);
    fs.writeFileSync(input, 'replacement bytes');
    const authenticatedChunks = [];
    for await (const chunk of authenticated.createReadStream()) {
      authenticatedChunks.push(chunk);
    }
    equal(Buffer.concat(authenticatedChunks).toString('utf8'), archive,
      'parsing keeps the authenticated open archive even if its path is replaced');
    authenticated.close();

    const executable = path.join(temporary, 'stockfish-source');
    fs.writeFileSync(executable, 'synthetic executable bytes');
    const executableSha256 = sha256('synthetic executable bytes');
    const verifiedExecutable = Compiler.prepareVerifiedExecutable(
      executable, executableSha256);
    equal(verifiedExecutable.sha256, executableSha256);
    ok(verifiedExecutable.path !== executable &&
      fs.readFileSync(verifiedExecutable.path, 'utf8') ===
        'synthetic executable bytes',
    'Stockfish runs from a private copy made from the authenticated descriptor');
    fs.writeFileSync(executable, 'replaced executable bytes');
    equal(fs.readFileSync(verifiedExecutable.path, 'utf8'),
      'synthetic executable bytes',
    'later source-path replacement cannot change the executable to be run');
    const verifiedDirectory = path.dirname(verifiedExecutable.path);
    function CapturingEngine(
      executablePath, log, watchdog, workingDirectory
    ) {
      this.executablePath = executablePath;
      this.log = log;
      this.watchdog = watchdog;
      this.workingDirectory = workingDirectory;
    }
    const capturedEngine = Compiler.createPinnedEngine(
      verifiedExecutable, contracts, CapturingEngine);
    equal(capturedEngine.executablePath, verifiedExecutable.path);
    equal(capturedEngine.watchdog, contracts.teacher.watchdog);
    equal(capturedEngine.workingDirectory, verifiedDirectory,
      'Stockfish starts in its authenticated private staging directory');
    verifiedExecutable.cleanup();
    equal(fs.existsSync(verifiedDirectory), false);

    const dependencies = Compiler.dependencyHashes();
    equal(Compiler.assertDependencyHashesUnchanged(dependencies),
      dependencies,
    'compiler dependencies remain byte-identical across a run');
    const driftedDependencies = JSON.parse(JSON.stringify(dependencies));
    driftedDependencies.compiler.sha256 = '0'.repeat(64);
    throws(function () {
      Compiler.assertDependencyHashesUnchanged(driftedDependencies);
    }, /compiler dependencies changed during the run/,
    'compiler detects mutation-relevant dependency drift');
    const output = path.join(temporary, 'candidates.ndjson');
    const sidecar = Compiler.buildSidecar({
      policy,
      contracts,
      dependencies,
      outputBytes,
      outputPath: output,
      actualExecutableSha256:
        contracts.teacher.engine.executable.sha256,
      result: good
    });
    equal(sidecar.rawArchive.id, 'lichess-standard-rated-pgn');
    equal(sidecar.rawArchive.bytes, 28241946492);
    equal(sidecar.rawArchive.sha256, policy.source.archive.sha256);
    equal(sidecar.rawArchive.forbiddenTorrentUrl,
      policy.source.forbiddenSources[0].url);
    equal(sidecar.provenance.configurationSha256,
      Compiler.configurationSha256(policy));
    [
      'sourcePolicy',
      'sourcePolicySchema',
      'candidateSchema',
      'candidateSidecarSchema',
      'freezeRequestSchema',
      'compiler',
      'engineRules',
      'pgnParser',
      'corpusContract',
      'canonicalJsonProducer',
      'stockfishAdapter',
      'candidateValidator',
      'e4ProtocolValidator',
      'teacherManifest',
      'heldoutManifest',
      'heldoutFixture',
      'trainingSourcePolicy'
    ].forEach(function (name) {
      ok(sidecar.provenance[name] &&
        /^[0-9a-f]{64}$/.test(sidecar.provenance[name].sha256),
      'sidecar pins mutation-relevant dependency ' + name);
      equal(sidecar.provenance[name].sha256,
        sha256(fs.readFileSync(path.join(
          Compiler.ROOT, sidecar.provenance[name].path))),
      'dependency pin is the hash of the exact current file bytes');
    });
    equal(sidecar.teacher.actualExecutableSha256,
      contracts.teacher.engine.executable.sha256);
    equal(sidecar.teacher.nodeLimit, 100000);
    equal(sidecar.teacher.networks.map(function (network) {
      return network.sha256;
    }), contracts.teacher.engine.networks.map(function (network) {
      return network.sha256;
    }), 'sidecar pins the ordered teacher network identities');
    equal(sidecar.output.rows, good.rows.length);
    equal(sidecar.output.sha256, sha256(outputBytes));
    equal(sidecar.output.bytes, Buffer.byteLength(outputBytes));
    equal(sidecar.teacher.results, {
      scoredPositions: good.rows.length,
      eligibleRows: good.rows.length,
      excludedAfterScoring: 0
    });
    ok(sidecar.extraction.rules &&
      sidecar.extraction.counts.outputRows === good.rows.length &&
      isFinite(sidecar.extraction.counts.gamesSeen),
    'sidecar binds extraction rules, counts, and exclusions');
    equal(Compiler.validateSidecar(sidecar, {
      policy,
      contracts,
      dependencies,
      outputBytes,
      outputPath: output
    }), true, 'exported strict sidecar validator accepts the exact artifact');
    const mutatedSidecar = JSON.parse(JSON.stringify(sidecar));
    mutatedSidecar.provenance.engineRules.sha256 = '0'.repeat(64);
    throws(function () {
      Compiler.validateSidecar(mutatedSidecar, {
        policy,
        contracts,
        dependencies,
        outputBytes,
        outputPath: output
      });
    }, /provenance mismatch: engineRules/,
    'sidecar validator detects a mutation-relevant code pin change');
    const unsafeOutputPath = JSON.parse(JSON.stringify(sidecar));
    unsafeOutputPath.output.path = '..\\candidates.ndjson';
    throws(function () {
      Compiler.validateSidecar(unsafeOutputPath, {
        policy,
        contracts,
        dependencies,
        outputBytes
      });
    }, /output identity\/accounting drifted/,
    'sidecar rejects a non-portable output basename');
    const unknownExclusion = JSON.parse(JSON.stringify(sidecar));
    unknownExclusion.extraction.exclusions.posthoc = 1;
    throws(function () {
      Compiler.validateSidecar(unknownExclusion, {
        policy,
        contracts,
        dependencies,
        outputBytes,
        outputPath: output
      });
    }, /reason\/count is not registered/,
    'sidecar validator rejects an unregistered exclusion reason');
    const inconsistentLedger = JSON.parse(JSON.stringify(sidecar));
    inconsistentLedger.extraction.counts.gamesSeen++;
    throws(function () {
      Compiler.validateSidecar(inconsistentLedger, {
        policy,
        contracts,
        dependencies,
        outputBytes,
        outputPath: output
      });
    }, /ledger is inconsistent/,
    'sidecar validator reconciles counts with the exclusion ledger');
    const overCap = JSON.parse(JSON.stringify(sidecar));
    Object.keys(overCap.extraction.counts).forEach(function (field) {
      overCap.extraction.counts[field] = 25001;
    });
    overCap.teacher.results.scoredPositions = 25001;
    overCap.teacher.results.eligibleRows = 25001;
    overCap.output.rows = 25001;
    throws(function () {
      Compiler.validateSidecar(overCap, {
        policy,
        contracts,
        dependencies
      });
    }, /exceeds the frozen candidate cap/,
    'sidecar validator rejects counts above the frozen candidate cap');

    Compiler.writeArtifacts(output, outputBytes, sidecar);
    const firstOutput = fs.readFileSync(output, 'utf8');
    const firstSidecar = fs.readFileSync(
      output + '.manifest.json', 'utf8');
    throws(function () {
      Compiler.writeArtifacts(output, outputBytes, sidecar);
    }, /refusing to overwrite/,
    'candidate output and sidecar are both no-replace artifacts');
    equal(fs.readFileSync(output, 'utf8'), firstOutput);
    equal(fs.readFileSync(output + '.manifest.json', 'utf8'),
      firstSidecar);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }

  console.log('prepare-e4-opening-candidates: ' + checks + ' checks passed');
}

main().catch(function (error) {
  console.error(error.stack || error);
  process.exitCode = 1;
});
