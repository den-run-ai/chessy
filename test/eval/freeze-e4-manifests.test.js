/*
 * Hermetic tests for the offline E4-v1 manifest freezer.
 *
 *   node test/eval/freeze-e4-manifests.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const E4 = require('./e4-protocol.js');
const Freezer = require('./freeze-e4-manifests.js');
const CandidateCompiler = require('./prepare-e4-opening-candidates.js');
const Corpus = require('../training/corpus.js');
const Prepare = require('../training/prepare-lichess-evals.js');
const Label = require('../training/label-stockfish.js');

let passed = 0;
let failed = 0;
const SOURCE_NAMESPACE =
  'chessy.e4.lichess-standard-rated.2026-06';
const RAW_ARCHIVE_SHA256 =
  '8fd81071f56511e7546cb77e38db5cf32f7e8a437fb906e26959cc064d8b1f79';
const CANDIDATE_MANIFEST_SHA256 = '3'.repeat(64);

function check(ok, label, detail) {
  if (ok) {
    passed++;
    console.log('  ok  ' + label);
  } else {
    failed++;
    console.error('FAIL  ' + label + (detail ? ' — ' + detail : ''));
  }
}

function expectThrow(label, expected, callback) {
  try {
    callback();
    check(false, label, 'did not throw');
  } catch (error) {
    const message = String(error && error.message || error);
    check(expected.test(message), label, message);
  }
}

async function expectReject(label, expected, callback) {
  try {
    await callback();
    check(false, label, 'did not reject');
  } catch (error) {
    const message = String(error && error.message || error);
    check(expected.test(message), label, message);
  }
}

function boardToFen(board) {
  const ranks = [];
  for (let rank = 0; rank < 8; rank++) {
    let text = '', empty = 0;
    for (let file = 0; file < 8; file++) {
      const piece = board[rank * 8 + file];
      if (!piece) {
        empty++;
      } else {
        if (empty) text += String(empty);
        empty = 0;
        text += piece;
      }
    }
    if (empty) text += String(empty);
    ranks.push(text);
  }
  return ranks.join('/') + ' w - - 0 7';
}

function opaqueId(kind, value) {
  return SOURCE_NAMESPACE + ':' + kind + ':' +
    E4.sha256('synthetic-freezer-fixture:' + kind + ':' + value);
}

function syntheticCandidates(count) {
  const candidates = [];
  const families = new Set();
  const whitePawnSquares = [48, 49, 50, 51, 52, 53, 54];
  const blackPawnSquares = [8, 9, 10, 11, 12, 13, 14];
  const attemptLimit = 20000;
  for (let serial = 1;
       candidates.length < count && serial <= attemptLimit;
       serial++) {
    const board = new Array(64).fill(null);
    board[4] = 'k';
    board[57] = 'N';
    board[60] = 'K';
    whitePawnSquares.forEach(function (square, bit) {
      if (serial & (1 << bit)) board[square] = 'P';
    });
    blackPawnSquares.forEach(function (square, bit) {
      if (serial & (1 << (bit + 7))) board[square] = 'p';
    });
    const fen = boardToFen(board);
    const family = Corpus.positionFamilyKey(fen);
    if (families.has(family) ||
        family === Freezer.INCIDENT_FAMILY) continue;
    families.add(family);
    const index = candidates.length;
    candidates.push({
      schema: 'chessy.e4.opening-candidate.v1',
      recordId: opaqueId('candidate', String(index).padStart(5, '0')),
      sourceGameId: opaqueId('game', String(index).padStart(5, '0')),
      fen,
      eco: String.fromCharCode(65 + (index % 5)) +
        String(index % 100).padStart(2, '0'),
      openingFamily: 'synthetic-family-' + (index % 17),
      initialBalanceCp: (index % 241) - 120
    });
  }
  if (candidates.length !== count) {
    throw new Error('synthetic fixture exhausted ' + attemptLimit +
      ' attempts at ' + candidates.length + '/' + count +
      ' unique structural families');
  }
  return candidates;
}

function normalizeCandidates(raw) {
  return raw.map(function (candidate, index) {
    return Freezer.validateCandidate(candidate, index + 1);
  });
}

function relocateWhiteKnight(fen) {
  const parsed = Corpus.parseFen4(fen);
  const board = parsed.board.flat();
  const from = board.indexOf('N');
  const to = 42;
  if (from < 0 || board[to] !== null) {
    throw new Error('synthetic opening lacks the expected movable white knight');
  }
  board[from] = null;
  board[to] = 'N';
  return boardToFen(board);
}

function evaluatedPosition(fen, cp) {
  return {
    fen,
    evals: [{
      depth: 20,
      knodes: 100,
      pvs: [{ cp, line: 'a2a3' }]
    }]
  };
}

function provenanceFor(candidateNdjsonSha256) {
  return {
    rawArchiveSha256: RAW_ARCHIVE_SHA256,
    candidateNdjsonSha256,
    candidateManifestSha256: CANDIDATE_MANIFEST_SHA256,
    source: {
      id: 'lichess-standard-rated-pgn',
      release: '2026-06',
      url: 'https://database.lichess.org/standard/' +
        'lichess_db_standard_rated_2026-06.pgn.zst',
      license: 'CC0-1.0'
    }
  };
}

function requestFor(candidateNdjsonSha256) {
  const teacher = Freezer.loadTeacherIdentity();
  const provenance = provenanceFor(candidateNdjsonSha256);
  return {
    schema: 'chessy.e4.freeze-request.v1',
    freezeBaseCommit: 'a'.repeat(40),
    source: {
      id: 'lichess-standard-rated-pgn',
      name: 'Lichess database',
      release: provenance.source.release,
      url: provenance.source.url,
      license: 'CC0-1.0'
    },
    rawArchiveSha256: provenance.rawArchiveSha256,
    candidateNdjsonSha256: provenance.candidateNdjsonSha256,
    candidateManifestSha256: provenance.candidateManifestSha256,
    stockfish: {
      executableSha256: teacher.executableSha256,
      networkSha256s: teacher.networkSha256s
    },
    exploration: E4.LEVELS.map(function (level) {
      return {
        level: level.id,
        anchorAllocation: [{
          elo: level.nominalElo,
          openingClusters: 1
        }]
      };
    })
  };
}

function selectedFamilySet(manifest, byCluster) {
  const families = new Set();
  manifest.openingClusters.forEach(function (opening) {
    byCluster.get(opening.clusterId).positionFamilies.forEach(function (family) {
      families.add(family);
    });
  });
  return families;
}

async function main() {
  const heldout = E4.readJson(path.join(
    __dirname, '..', '..', 'eval', 'training', 'heldout-v1.json'));
  const fixtureBytes = fs.readFileSync(path.join(
    __dirname, '..', '..', heldout.sourceFixture));
  const heldoutIdentity = Freezer.validateHeldoutIdentity(
    heldout, fixtureBytes);
  check(heldoutIdentity.cluster === Freezer.INCIDENT_CLUSTER &&
    heldoutIdentity.family === Freezer.INCIDENT_FAMILY &&
    Freezer.SELECTOR_CONTRACT_PATHS.includes('eval/training/heldout-v1.json'),
  'selector loads and hashes the checked-in incident quarantine contract');
  expectThrow(
    'held-out cluster/family drift fails closed',
    /do not derive from the incident FEN/,
    function () {
      const changed = JSON.parse(JSON.stringify(heldout));
      changed.symmetryPolicy.clusterSha256 = 'f'.repeat(64);
      Freezer.validateHeldoutIdentity(changed, fixtureBytes);
    });

  const raw = syntheticCandidates(4012);
  const normalized = normalizeCandidates(raw);
  const sourceSha256 = '1'.repeat(64);
  const request = Freezer.validateRequest(
    requestFor(sourceSha256), provenanceFor(sourceSha256));
  const components = Freezer.buildComponents(normalized);
  check(components.length === raw.length,
    'synthetic candidates form distinct structural components');

  const incident = Freezer.validateCandidate({
    schema: 'chessy.e4.opening-candidate.v1',
    recordId: opaqueId('candidate', 'incident'),
    sourceGameId: opaqueId('game', 'incident'),
    fen: 'r4rk1/ppp2ppp/2n5/2b1pb2/8/1P1P1N2/q1PBBPPP/1R1Q1RK1 w - - 0 7',
    eco: 'A00',
    openingFamily: 'locked-incident',
    initialBalanceCp: 0
  }, 1);
  check(Freezer.buildComponents([incident]).length === 0,
    'locked incident family is excluded before selection');

  const linkedRaw = syntheticCandidates(2);
  linkedRaw[1].sourceGameId = linkedRaw[0].sourceGameId;
  const linked = Freezer.buildComponents(normalizeCandidates(linkedRaw));
  check(linked.length === 1 &&
    linked[0].opening.sourceRecordIds.length === 2 &&
    linked[0].opening.clusterMembers.length === 2,
  'different positions from one source game coalesce transitively');

  const mirroredRaw = syntheticCandidates(1)[0];
  const mirror = Object.assign({}, mirroredRaw, {
    recordId: opaqueId('candidate', 'mirror'),
    sourceGameId: opaqueId('game', 'mirror'),
    fen: Corpus.transformFen4(mirroredRaw.fen, 'file-mirror') + ' 0 7'
  });
  const mirrored = Freezer.buildComponents(normalizeCandidates([
    mirroredRaw, mirror
  ]));
  check(mirrored.length === 1 &&
    mirrored[0].opening.sourceRecordIds.length === 2,
  'mirrors and transposed-equivalent boards share one component');

  const initialSelectorSnapshot = Freezer.loadSelectorSnapshot();
  const selectorSha256 = initialSelectorSnapshot.sha256;
  const first = Freezer.compileManifests({
    request,
    components,
    candidateNdjsonSha256: sourceSha256,
    selectorSha256,
    templateSnapshot: initialSelectorSnapshot.templates
  });
  const second = Freezer.compileManifests({
    request,
    components: components.slice().reverse(),
    candidateNdjsonSha256: sourceSha256,
    selectorSha256
  });
  let withoutLocaleCollation = null;
  const originalLocaleCompare = String.prototype.localeCompare;
  try {
    String.prototype.localeCompare = function () {
      throw new Error('locale collation entered deterministic freezer');
    };
    withoutLocaleCollation = Freezer.compileManifests({
      request,
      components: components.slice().reverse(),
      candidateNdjsonSha256: sourceSha256,
      selectorSha256
    });
  } finally {
    String.prototype.localeCompare = originalLocaleCompare;
  }
  check(first.certification.assignments.length === 4000 &&
    first.certification.openingClusters.length === 4000 &&
    first.exploration.assignments.length === 5,
  'freeze emits 4,000 certification assignments and predeclared exploration');
  check(first.certification.assignments[0].scheduleKind === 'cert' &&
    first.certification.assignments[0].levelOrPair === 'master' &&
    first.certification.assignments[2399].levelOrPair === 'expert' &&
    first.certification.assignments[2400].scheduleKind === 'adjacent',
  'certification assignment order is Master first, then other levels, then adjacent');
  check(first.certification.freeze.contentSha256 ===
    second.certification.freeze.contentSha256 &&
    first.exploration.freeze.contentSha256 ===
      second.exploration.freeze.contentSha256,
  'selection and canonical manifest IDs are independent of candidate array order');
  check(first.certification.freeze.contentSha256 ===
    withoutLocaleCollation.certification.freeze.contentSha256 &&
    first.exploration.freeze.contentSha256 ===
      withoutLocaleCollation.exploration.freeze.contentSha256,
  'selection uses code-point order without host locale collation');
  check(E4.validateManifestSet(first.exploration, first.certification),
    'generated manifest pair passes the executable E4 validator');

  const componentById = new Map(components.map(function (component) {
    return [component.clusterId, component];
  }));
  const certFamilies = selectedFamilySet(
    first.certification, componentById);
  const explorationFamilies = selectedFamilySet(
    first.exploration, componentById);
  check(Array.from(explorationFamilies).every(function (family) {
    return !certFamilies.has(family);
  }), 'exploration and certification have no structural-family overlap');
  check(first.certification.freeze.stockfishNetworkSha256s.length === 2 &&
    E4.stableJson(first.certification.freeze.stockfishNetworkSha256s) ===
      E4.stableJson(Freezer.loadTeacherIdentity().networkSha256s),
  'frozen provenance preserves both ordered Stockfish network hashes');

  expectThrow(
    'candidate schema rejects undeclared fields',
    /exactly/,
    function () {
      Freezer.validateCandidate(Object.assign({}, raw[0], { surprise: true }), 7);
    });
  expectThrow(
    'candidate schema rejects raw source-game identity',
    /opaque SHA-256 identity/,
    function () {
      Freezer.validateCandidate(Object.assign({}, raw[0], {
        sourceGameId: 'https://lichess.org/AbCd1234'
      }), 8);
    });
  expectThrow(
    'candidate schema rejects malformed FEN move counters',
    /halfmove clock/,
    function () {
      const fields = raw[0].fen.split(' ');
      fields[4] = 'not-a-clock';
      Freezer.validateCandidate(Object.assign({}, raw[0], {
        fen: fields.join(' ')
      }), 9);
    });
  expectThrow(
    'candidate schema rejects a noncanonical six-field FEN',
    /already be canonical/,
    function () {
      const fields = raw[0].fen.split(' ');
      fields[3] = 'e6';
      Freezer.validateCandidate(Object.assign({}, raw[0], {
        fen: fields.join(' ')
      }), 10);
    });
  expectThrow(
    'candidate schema rejects counters outside candidate plies 12..20',
    /candidate ply 12\.\.20/,
    function () {
      const fields = raw[0].fen.split(' ');
      fields[5] = '999';
      Freezer.validateCandidate(Object.assign({}, raw[0], {
        fen: fields.join(' ')
      }), 11);
    });
  expectThrow(
    'request rejects a changed Stockfish network identity',
    /network hashes\/order/,
    function () {
      const changed = requestFor(sourceSha256);
      changed.stockfish.networkSha256s[1] = 'f'.repeat(64);
      Freezer.validateRequest(changed, provenanceFor(sourceSha256));
    });
  expectThrow(
    'undersized pool fails closed instead of reusing openings',
    /insufficient disjoint opening components/,
    function () {
      Freezer.compileManifests({
        request,
        components: components.slice(0, 4000),
        candidateNdjsonSha256: sourceSha256,
        selectorSha256
      });
    });

  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'chessy-e4-freezer-test-'));
  try {
    const repositoryRoot = path.join(__dirname, '..', '..');
    const selectorCopyRoot = path.join(temporary, 'selector-copy');
    const selectorSnapshot = Freezer.loadSelectorSnapshot(repositoryRoot);
    selectorSnapshot.pins.forEach(function (pin) {
      const target = path.join(selectorCopyRoot, pin.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(repositoryRoot, pin.path), target);
    });
    const copiedSnapshot = Freezer.loadSelectorSnapshot(selectorCopyRoot);
    check(copiedSnapshot.sha256 === selectorSnapshot.sha256,
      'selector snapshot captures the exact template and contract bytes');
    fs.appendFileSync(path.join(
      selectorCopyRoot,
      'eval/e4/exploration-manifest.template.json'
    ), '\n');
    expectThrow(
      'pre-write gate rejects selector/template mutation after capture',
      /selector contract changed before frozen manifests were written/,
      function () {
        Freezer.assertSelectorSnapshotHash(
          selectorCopyRoot, copiedSnapshot.sha256);
      });

    const explorationPath = path.join(temporary, 'exploration.json');
    const certificationPath = path.join(temporary, 'certification.json');
    Freezer.writeJsonPair(explorationPath, certificationPath, first);
    check(
      E4.readJson(explorationPath).freeze.contentSha256 ===
        first.exploration.freeze.contentSha256 &&
      E4.readJson(certificationPath).freeze.contentSha256 ===
        first.certification.freeze.contentSha256,
    'writer creates both validated manifests');
    expectThrow(
      'writer refuses to overwrite either frozen output',
      /refusing to overwrite/,
      function () {
        Freezer.writeJsonPair(explorationPath, certificationPath, first);
      });

    const certifiedOpening = first.certification.openingClusters[0];
    const certifiedFamilyVariant = relocateWhiteKnight(certifiedOpening.fen);
    check(
      Corpus.clusterKey(certifiedFamilyVariant) !==
        Corpus.clusterKey(certifiedOpening.fen) &&
      Corpus.positionFamilyKey(certifiedFamilyVariant) ===
        Corpus.positionFamilyKey(certifiedOpening.fen),
    'frozen-certification test fixture has a family-only variant');
    const selectedFamilies = new Set([
      ...selectedFamilySet(first.certification, componentById),
      ...selectedFamilySet(first.exploration, componentById)
    ]);
    const safeComponent = components.find(function (component) {
      return component.positionFamilies.every(function (family) {
        return !selectedFamilies.has(family);
      });
    });
    check(Boolean(safeComponent),
      'frozen-certification test fixture retains one safe corpus component');
    const corpusInput = path.join(temporary, 'corpus-source.jsonl');
    const corpusOutput = path.join(temporary, 'corpus-selection');
    const corpusText = [
      evaluatedPosition(certifiedOpening.fen, 12),
      evaluatedPosition(certifiedFamilyVariant, 13),
      evaluatedPosition(safeComponent.opening.fen, 14)
    ].map(JSON.stringify).join('\n') + '\n';
    fs.writeFileSync(corpusInput, corpusText);
    const selection = await Prepare.prepare({
      input: corpusInput,
      output: corpusOutput,
      'source-sha256': Corpus.sha256(corpusText),
      retrieved: '2026-07-30',
      'certification-manifest': certificationPath,
      modulus: '1',
      numerator: '1',
      shards: '1',
      'minimum-selected': '1',
      'allow-missing-roles': 'true'
    });
    check(
      selection.exclusions.certificationStatus === 'frozen' &&
      selection.exclusions.pendingCertificationAllowedForTestOnly === false &&
      selection.exclusions.certificationClusterCount === 4000 &&
      selection.counts.certificationClusterExcluded === 1 &&
      selection.counts.certificationFamilyExcluded === 1 &&
      selection.counts.selected === 1,
    'production selection exercises non-empty frozen certification quarantine');
    const selectedCorpus = fs.readFileSync(
      path.join(corpusOutput, 'selection-000.ndjson'), 'utf8');
    check(
      !selectedCorpus.includes(Corpus.clusterKey(certifiedOpening.fen)) &&
      !selectedCorpus.includes(Corpus.positionFamilyKey(certifiedOpening.fen)),
    'frozen certification cluster and family are absent from selected corpus');

    const tinyPath = path.join(temporary, 'tiny.ndjson');
    fs.writeFileSync(tinyPath, JSON.stringify(raw[0]) + '\n');
    const tinySha = await Freezer.sha256File(tinyPath);
    const tinyRequest = requestFor(tinySha);
    tinyRequest.candidateNdjsonSha256 = '0'.repeat(64);
    expectThrow(
      'freeze request is bound to the exact candidate-file SHA-256',
      /does not match/,
      function () {
        Freezer.validateRequest(tinyRequest, provenanceFor(tinySha));
      });
    await expectReject(
      'NDJSON reader rejects noncanonical JSON bytes',
      /not canonical JSON/,
      function () {
        return Freezer.readCandidates(tinyPath);
      });

    const authenticatedPath = path.join(
      temporary, 'authenticated-candidates.ndjson');
    const authenticatedBytes = CandidateCompiler.renderNdjson([raw[0]]);
    fs.writeFileSync(authenticatedPath, authenticatedBytes);
    const contracts = Label.loadFrozenContracts();
    const sidecar = CandidateCompiler.buildSidecar({
      policy: CandidateCompiler.loadSourcePolicy(),
      contracts,
      dependencies: CandidateCompiler.dependencyHashes(),
      outputBytes: authenticatedBytes,
      outputPath: authenticatedPath,
      actualExecutableSha256:
        contracts.teacher.engine.executable.sha256,
      result: {
        rows: [raw[0]],
        counts: {
          gamesSeen: 1,
          sourceFilterEligible: 1,
          hashSampled: 1,
          legalCandidatePositions: 1,
          retainedForScoring: 1,
          scored: 1,
          outputRows: 1
        },
        exclusions: {}
      }
    });
    const sidecarPath = authenticatedPath + '.manifest.json';
    const sidecarBytes = Prepare.stableJson(sidecar) + '\n';
    fs.writeFileSync(sidecarPath, sidecarBytes);
    const authenticatedInput =
      await Freezer.readCandidates(authenticatedPath);
    const authenticatedProvenance = Freezer.loadCandidateProvenance(
      sidecarPath, authenticatedPath, authenticatedInput);
    check(
      authenticatedInput.sha256 === E4.sha256(authenticatedBytes) &&
      authenticatedInput.bytes === Buffer.byteLength(authenticatedBytes) &&
      authenticatedProvenance.rawArchiveSha256 === RAW_ARCHIVE_SHA256 &&
      authenticatedProvenance.candidateNdjsonSha256 ===
        authenticatedInput.sha256 &&
      authenticatedProvenance.candidateManifestSha256 ===
        E4.sha256(sidecarBytes),
    'single-pass candidate bytes and strict sidecar authenticate all three artifacts');

    const changedSidecar = JSON.parse(JSON.stringify(sidecar));
    changedSidecar.rawArchive.sha256 = '0'.repeat(64);
    const changedSidecarPath = path.join(temporary, 'changed-sidecar.json');
    fs.writeFileSync(
      changedSidecarPath, Prepare.stableJson(changedSidecar) + '\n');
    expectThrow(
      'freezer rejects a sidecar with changed raw-archive provenance',
      /raw archive identity drifted/,
      function () {
        Freezer.loadCandidateProvenance(
          changedSidecarPath, authenticatedPath, authenticatedInput);
      });
    const posthocSidecar = JSON.parse(JSON.stringify(sidecar));
    posthocSidecar.extraction.exclusions.posthoc = 1;
    const posthocSidecarPath = path.join(
      temporary, 'posthoc-sidecar.json');
    fs.writeFileSync(
      posthocSidecarPath, Prepare.stableJson(posthocSidecar) + '\n');
    expectThrow(
      'freezer rejects an unregistered sidecar exclusion reason',
      /reason\/count is not registered/,
      function () {
        Freezer.loadCandidateProvenance(
          posthocSidecarPath, authenticatedPath, authenticatedInput);
      });

    const duplicateGamePath = path.join(
      temporary, 'duplicate-game.ndjson');
    const duplicateGameRows = [
      raw[0],
      Object.assign({}, raw[1], {
        sourceGameId: raw[0].sourceGameId
      })
    ].sort(function (left, right) {
      return left.recordId < right.recordId ? -1 : 1;
    });
    fs.writeFileSync(
      duplicateGamePath,
      duplicateGameRows.map(E4.stableJson).join('\n') + '\n');
    await expectReject(
      'NDJSON reader rejects a second candidate from one source game',
      /duplicate candidate sourceGameId/,
      function () {
        return Freezer.readCandidates(duplicateGamePath);
      });

    const invalidUtf8Path = path.join(temporary, 'invalid-utf8.ndjson');
    const invalidUtf8Bytes = Buffer.from(E4.stableJson(raw[0]) + '\n');
    const familyOffset = invalidUtf8Bytes.indexOf(
      Buffer.from(raw[0].openingFamily));
    if (familyOffset < 0) {
      throw new Error('synthetic opening family was not serialized');
    }
    invalidUtf8Bytes[familyOffset] = 0xff;
    fs.writeFileSync(invalidUtf8Path, invalidUtf8Bytes);
    await expectReject(
      'NDJSON reader rejects malformed UTF-8 bytes',
      /must be valid UTF-8/,
      function () {
        return Freezer.readCandidates(invalidUtf8Path);
      });

    const malformedPath = path.join(temporary, 'malformed.ndjson');
    fs.writeFileSync(malformedPath, E4.stableJson(Object.assign(
      {}, raw[0], { unknown: 1 })) + '\n');
    await expectReject(
      'NDJSON reader rejects unknown candidate fields',
      /exactly/,
      function () {
        return Freezer.readCandidates(malformedPath);
      });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }

  console.log('\n' + passed + ' freezer checks passed.');
  if (failed) {
    console.error(failed + ' freezer checks failed.');
    process.exitCode = 1;
  }
}

main().catch(function (error) {
  console.error('FAIL: ' + String(error && error.stack || error));
  process.exitCode = 1;
});
