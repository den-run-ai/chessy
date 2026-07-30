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
const Corpus = require('../training/corpus.js');

let passed = 0;
let failed = 0;

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
  return ranks.join('/') + ' w - - 0 1';
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
      recordId: 'record-' + String(index).padStart(5, '0'),
      sourceGameId: 'game-' + String(index).padStart(5, '0'),
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

function requestFor(sourceSha256) {
  const teacher = Freezer.loadTeacherIdentity();
  return {
    schema: 'chessy.e4.freeze-request.v1',
    freezeBaseCommit: 'a'.repeat(40),
    source: {
      name: 'Lichess database',
      release: 'synthetic-cc0-v1',
      url: 'https://example.invalid/synthetic-cc0-v1',
      license: 'CC0-1.0'
    },
    sourceArchiveSha256: sourceSha256,
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
    requestFor(sourceSha256), sourceSha256);
  const components = Freezer.buildComponents(normalized);
  check(components.length === raw.length,
    'synthetic candidates form distinct structural components');

  const incident = Freezer.validateCandidate({
    schema: 'chessy.e4.opening-candidate.v1',
    recordId: 'incident',
    sourceGameId: 'incident-game',
    fen: 'r4rk1/ppp2ppp/2n5/2b1pb2/8/1P1P1N2/q1PBBPPP/1R1Q1RK1 b - - 0 11',
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
    recordId: 'mirror-record',
    sourceGameId: 'mirror-game',
    fen: Corpus.transformFen4(mirroredRaw.fen, 'file-mirror')
  });
  const mirrored = Freezer.buildComponents(normalizeCandidates([
    mirroredRaw, mirror
  ]));
  check(mirrored.length === 1 &&
    mirrored[0].opening.sourceRecordIds.length === 2,
  'mirrors and transposed-equivalent boards share one component');

  const selectorSha256 = Freezer.selectionCodeSha256();
  const first = Freezer.compileManifests({
    request,
    components,
    sourceSha256,
    selectorSha256
  });
  const second = Freezer.compileManifests({
    request,
    components: components.slice().reverse(),
    sourceSha256,
    selectorSha256
  });
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
    'request rejects a changed Stockfish network identity',
    /network hashes\/order/,
    function () {
      const changed = requestFor(sourceSha256);
      changed.stockfish.networkSha256s[1] = 'f'.repeat(64);
      Freezer.validateRequest(changed, sourceSha256);
    });
  expectThrow(
    'undersized pool fails closed instead of reusing openings',
    /insufficient disjoint opening components/,
    function () {
      Freezer.compileManifests({
        request,
        components: components.slice(0, 4000),
        sourceSha256,
        selectorSha256
      });
    });

  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'chessy-e4-freezer-test-'));
  try {
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

    const tinyPath = path.join(temporary, 'tiny.ndjson');
    fs.writeFileSync(tinyPath, JSON.stringify(raw[0]) + '\n');
    const tinySha = await Freezer.sha256File(tinyPath);
    const tinyRequest = requestFor(tinySha);
    tinyRequest.sourceArchiveSha256 = '0'.repeat(64);
    expectThrow(
      'freeze request is bound to the exact candidate-file SHA-256',
      /does not match/,
      function () {
        Freezer.validateRequest(tinyRequest, tinySha);
      });

    const malformedPath = path.join(temporary, 'malformed.ndjson');
    fs.writeFileSync(malformedPath, JSON.stringify(Object.assign(
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
