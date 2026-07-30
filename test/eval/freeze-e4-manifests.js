/*
 * Offline E4-v1 opening-manifest freezer.
 *
 * This compiler never downloads data, runs Stockfish, or touches Chessy's
 * runtime. It turns one already-pinned CC0 opening-candidate NDJSON file and
 * one predeclared freeze request into new immutable exploration and
 * certification manifests.
 *
 *   node test/eval/freeze-e4-manifests.js \
 *     --candidates /data/e4-opening-candidates.ndjson \
 *     --request /data/e4-freeze-request.json \
 *     --exploration-out /data/e4-exploration-frozen.json \
 *     --certification-out /data/e4-certification-frozen.json
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const E4 = require('./e4-protocol.js');
const Corpus = require('../training/corpus.js');

const ROOT = path.join(__dirname, '..', '..');
const EXPLORATION_TEMPLATE = path.join(
  ROOT, 'eval', 'e4', 'exploration-manifest.template.json');
const CERTIFICATION_TEMPLATE = path.join(
  ROOT, 'eval', 'e4', 'certification-manifest.template.json');
const TEACHER_MANIFEST = path.join(
  ROOT, 'eval', 'training', 'teacher-sf18-100kn-v1.json');
const SELECTOR_CONTRACT_PATHS = Object.freeze([
  'test/eval/freeze-e4-manifests.js',
  'test/eval/e4-protocol.js',
  'test/training/corpus.js',
  'eval/e4/adapter-v1.json',
  'eval/e4/protocol-v1.json',
  'eval/e4/exploration-manifest.schema.json',
  'eval/e4/certification-manifest.schema.json',
  'eval/e4/exploration-manifest.template.json',
  'eval/e4/certification-manifest.template.json',
  'eval/training/heldout-v1.json',
  'test/fixtures/master-e4-regression-20260729.json',
  'eval/training/teacher-sf18-100kn-v1.json'
]);
const CANDIDATE_KEYS = Object.freeze([
  'schema',
  'recordId',
  'sourceGameId',
  'fen',
  'eco',
  'openingFamily',
  'initialBalanceCp'
]);
const REQUEST_KEYS = Object.freeze([
  'schema',
  'freezeBaseCommit',
  'source',
  'sourceArchiveSha256',
  'stockfish',
  'exploration'
]);
const SOURCE_KEYS = Object.freeze([
  'name', 'release', 'url', 'license'
]);
const STOCKFISH_KEYS = Object.freeze([
  'executableSha256', 'networkSha256s'
]);
const EXPLORATION_REQUEST_KEYS = Object.freeze([
  'level', 'anchorAllocation'
]);
const ALLOCATION_KEYS = Object.freeze([
  'elo', 'openingClusters'
]);
const HELDOUT_MANIFEST = path.join(
  ROOT, 'eval', 'training', 'heldout-v1.json');

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function isObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertExactKeys(value, expected, label) {
  assert(isObject(value), label + ' must be an object');
  const actual = Object.keys(value).sort();
  const wanted = expected.slice().sort();
  assert(E4.stableJson(actual) === E4.stableJson(wanted),
    label + ' must contain exactly [' + wanted.join(', ') + '], got [' +
      actual.join(', ') + ']');
}

function assertSha(value, label) {
  assert(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value),
    label + ' must be a literal 64-character lowercase SHA-256');
}

function assertGitSha(value, label) {
  assert(typeof value === 'string' && /^[0-9a-f]{40}$/.test(value),
    label + ' must be a literal 40-character lowercase Git commit');
}

function assertText(value, label, maximum) {
  assert(typeof value === 'string' && value.length > 0 &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value) &&
    value.length <= maximum,
  label + ' must be nonempty trimmed text of at most ' + maximum +
    ' characters with no controls');
}

function validateHeldoutIdentity(manifest, fixtureBytes) {
  assert(isObject(manifest) && manifest.schemaVersion === 1 &&
    manifest.policy === 'locked-post-fit-evidence-only',
  'held-out manifest identity/policy drifted');
  assertText(manifest.sourceFixture, 'held-out source fixture path', 512);
  assert(!path.isAbsolute(manifest.sourceFixture) &&
    !manifest.sourceFixture.split(/[\\/]/).includes('..'),
  'held-out source fixture must be a repository-relative path');
  assertSha(manifest.sourceFixtureSha256,
    'held-out source fixture SHA-256');
  assert(Buffer.isBuffer(fixtureBytes) &&
    E4.sha256(fixtureBytes) === manifest.sourceFixtureSha256,
  'held-out source fixture bytes do not match their SHA-256 pin');
  assert(isObject(manifest.incident) &&
    manifest.incident.release === E4.EXPECTED.release &&
    manifest.incident.commit === E4.EXPECTED.commit &&
    manifest.incident.wasmSha256 === E4.EXPECTED.wasmSha256 &&
    manifest.incident.requireFixDefault === false &&
    manifest.incident.exactNodeGate === 9187327 &&
    manifest.incident.playedUci === 'c5d4' &&
    manifest.incident.requiredCandidateUci === 'e5e4',
  'held-out incident identity/gate drifted');
  const parsed = Corpus.validateSourceState(manifest.incident.fen);
  assert(parsed.fen4 === manifest.incident.fen4,
    'held-out incident fen4 does not match its source FEN');
  assert(isObject(manifest.symmetryPolicy),
    'held-out symmetry policy is missing');
  const expectedFens = Corpus.symmetryFens(parsed.fen4);
  assert(E4.stableJson(manifest.symmetryPolicy.transforms) ===
    E4.stableJson(Corpus.TRANSFORMS),
  'held-out symmetry transform set drifted');
  assert(manifest.symmetryPolicy.canonicalFen4 ===
    Corpus.canonicalFen4(parsed.fen4) &&
    manifest.symmetryPolicy.canonicalModelBoard ===
      Corpus.canonicalModelBoard(parsed.fen4) &&
    manifest.symmetryPolicy.clusterSha256 ===
      Corpus.clusterKey(parsed.fen4) &&
    manifest.symmetryPolicy.positionFamilySha256 ===
      Corpus.positionFamilyKey(parsed.fen4) &&
    E4.stableJson(manifest.symmetryPolicy.fens4) ===
      E4.stableJson(expectedFens),
  'held-out symmetry/cluster/family pins do not derive from the incident FEN');
  const fixture = JSON.parse(fixtureBytes.toString('utf8'));
  assert(fixture && fixture.regression &&
    fixture.regression.fen === manifest.incident.fen &&
    fixture.regression.playedUci === manifest.incident.playedUci &&
    fixture.regression.targetUci === manifest.incident.requiredCandidateUci &&
    fixture.regression.r69Replay &&
    fixture.regression.r69Replay.nodeLimit === manifest.incident.exactNodeGate,
  'held-out source fixture disagrees with the incident manifest');
  const exclusion = manifest.exclusion;
  const controls = exclusion && exclusion.controls;
  assert(E4.stableJson(exclusion && exclusion.applyBefore) ===
    E4.stableJson([
      'augmentation',
      'deduplication',
      'split-assignment',
      'exploration-label-use',
      'teacher-relabel',
      'training'
    ]) &&
    controls && controls.incidentClusterAndFamily &&
    controls.incidentClusterAndFamily.status === 'enforced' &&
    controls.sameSourceGameLineage &&
    controls.sameSourceGameLineage.status === 'pending-source-game-id' &&
    controls.sameSourceGameLineage.mechanism === null &&
    controls.nearbyBudgetProbes &&
    controls.nearbyBudgetProbes.trainingStatus ===
      'enforced-by-incident-family' &&
    controls.nearbyBudgetProbes.budgetStatus === 'preregistered' &&
    E4.stableJson(controls.nearbyBudgetProbes.nodes) ===
      E4.stableJson([8268594, 10106060]) &&
    controls.nearbyBudgetProbes.budgetContract ===
      'eval/training/hce-r3-fit-v1.json#/lockedPostFitGate/nearbyNodes' &&
    controls.nearbyBudgetProbes.executionEvidenceStatus ===
      'pending-post-fit-execution',
  'held-out exclusion control status drifted');
  return {
    fen: manifest.incident.fen,
    cluster: manifest.symmetryPolicy.clusterSha256,
    family: manifest.symmetryPolicy.positionFamilySha256
  };
}

function loadHeldoutIdentity(root) {
  const repositoryRoot = root || ROOT;
  const manifestPath = path.join(
    repositoryRoot, path.relative(ROOT, HELDOUT_MANIFEST));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const fixturePath = path.join(repositoryRoot, manifest.sourceFixture);
  return validateHeldoutIdentity(manifest, fs.readFileSync(fixturePath));
}

const PINNED_HELDOUT = loadHeldoutIdentity(ROOT);
const INCIDENT_CLUSTER = PINNED_HELDOUT.cluster;
const INCIDENT_FAMILY = PINNED_HELDOUT.family;

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(file);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

function selectionCodeSha256(root) {
  const repositoryRoot = root || ROOT;
  const pins = SELECTOR_CONTRACT_PATHS.map(function (relative) {
    const bytes = fs.readFileSync(path.join(repositoryRoot, relative));
    return { path: relative, sha256: E4.sha256(bytes) };
  });
  return E4.canonicalSha256(pins);
}

function loadTeacherIdentity(root) {
  const repositoryRoot = root || ROOT;
  const manifest = JSON.parse(fs.readFileSync(
    path.join(repositoryRoot,
      path.relative(ROOT, TEACHER_MANIFEST)), 'utf8'));
  assert(manifest && manifest.engine &&
    manifest.engine.name === 'Stockfish 18' &&
    manifest.engine.release === 'sf_18' &&
    manifest.engine.sourceCommit === E4.EXPECTED.anchorCommit,
  'checked-in teacher manifest is not the pinned Stockfish 18 identity');
  assert(manifest.engine.executable, 'teacher executable identity is missing');
  assertSha(manifest.engine.executable.sha256,
    'teacher executable SHA-256');
  assert(Array.isArray(manifest.engine.networks) &&
    manifest.engine.networks.length === 2,
  'teacher manifest must pin exactly EvalFile and EvalFileSmall');
  const expectedOptions = ['EvalFile', 'EvalFileSmall'];
  const networkSha256s = manifest.engine.networks.map(function (network, index) {
    assert(isObject(network) && network.option === expectedOptions[index],
      'teacher network order must be EvalFile then EvalFileSmall');
    assertSha(network.sha256, 'teacher ' + expectedOptions[index] + ' SHA-256');
    return network.sha256;
  });
  return {
    executableSha256: manifest.engine.executable.sha256,
    networkSha256s
  };
}

function validateRequest(request, sourceSha256, root) {
  assertExactKeys(request, REQUEST_KEYS, 'freeze request');
  assert(request.schema === 'chessy.e4.freeze-request.v1',
    'freeze request schema must be chessy.e4.freeze-request.v1');
  assertGitSha(request.freezeBaseCommit, 'freeze request base commit');
  assertExactKeys(request.source, SOURCE_KEYS, 'freeze request source');
  assert(request.source.name === 'Lichess database',
    'certification requires source.name="Lichess database"');
  assertText(request.source.release, 'source release', 256);
  assertText(request.source.url, 'source URL', 2048);
  assert(/^https:\/\//.test(request.source.url),
    'source URL must be an explicit HTTPS provenance URL');
  assert(request.source.license === 'CC0-1.0',
    'opening candidates must be explicitly CC0-1.0');
  assertSha(request.sourceArchiveSha256, 'source archive SHA-256');
  assert(request.sourceArchiveSha256 === sourceSha256,
    'candidate file SHA-256 does not match request.sourceArchiveSha256');

  assertExactKeys(request.stockfish, STOCKFISH_KEYS,
    'freeze request Stockfish identity');
  assertSha(request.stockfish.executableSha256,
    'freeze request Stockfish executable SHA-256');
  assert(Array.isArray(request.stockfish.networkSha256s) &&
    request.stockfish.networkSha256s.length === 2,
  'freeze request must contain exactly two ordered Stockfish network hashes');
  request.stockfish.networkSha256s.forEach(function (value, index) {
    assertSha(value, 'freeze request Stockfish network[' + index + '] SHA-256');
  });
  const teacher = loadTeacherIdentity(root);
  assert(request.stockfish.executableSha256 === teacher.executableSha256,
    'freeze request executable hash does not match the checked-in teacher');
  assert(E4.stableJson(request.stockfish.networkSha256s) ===
    E4.stableJson(teacher.networkSha256s),
  'freeze request network hashes/order do not match EvalFile then EvalFileSmall');

  assert(Array.isArray(request.exploration) &&
    request.exploration.length === E4.LEVELS.length,
  'freeze request needs exactly one exploration allocation per level');
  const seenLevels = new Set();
  request.exploration.forEach(function (schedule, scheduleIndex) {
    assertExactKeys(schedule, EXPLORATION_REQUEST_KEYS,
      'exploration[' + scheduleIndex + ']');
    const level = E4.LEVELS[scheduleIndex];
    assert(schedule.level === level.id,
      'exploration schedule order must be easy, medium, hard, expert, master');
    assert(!seenLevels.has(schedule.level),
      'duplicate exploration level: ' + schedule.level);
    seenLevels.add(schedule.level);
    assert(Array.isArray(schedule.anchorAllocation) &&
      schedule.anchorAllocation.length > 0 &&
      schedule.anchorAllocation.length <= level.anchors.length,
    'exploration ' + level.id + ' needs one to three nearest-anchor allocations');
    const seenAnchors = new Set();
    schedule.anchorAllocation.forEach(function (allocation, allocationIndex) {
      assertExactKeys(allocation, ALLOCATION_KEYS,
        'exploration[' + scheduleIndex + '].anchorAllocation[' +
          allocationIndex + ']');
      assert(Number.isInteger(allocation.elo) &&
        level.anchors.includes(allocation.elo),
      'exploration ' + level.id + ' uses an anchor outside its nearest three');
      assert(!seenAnchors.has(allocation.elo),
        'duplicate exploration anchor: ' + level.id + '/' + allocation.elo);
      seenAnchors.add(allocation.elo);
      assert(Number.isSafeInteger(allocation.openingClusters) &&
        allocation.openingClusters > 0,
      'exploration openingClusters must be a positive safe integer');
    });
  });
  return clone(request);
}

function validateCandidate(raw, lineNumber) {
  const label = 'candidate line ' + lineNumber;
  assertExactKeys(raw, CANDIDATE_KEYS, label);
  assert(raw.schema === 'chessy.e4.opening-candidate.v1',
    label + ' schema must be chessy.e4.opening-candidate.v1');
  assertText(raw.recordId, label + '.recordId', 512);
  assertText(raw.sourceGameId, label + '.sourceGameId', 512);
  assertText(raw.fen, label + '.fen', 256);
  assert(typeof raw.eco === 'string' && /^[A-E][0-9]{2}$/.test(raw.eco),
    label + '.eco must match [A-E][0-9]{2}');
  assertText(raw.openingFamily, label + '.openingFamily', 256);
  assert(Number.isSafeInteger(raw.initialBalanceCp) &&
    Math.abs(raw.initialBalanceCp) <= 32000,
  label + '.initialBalanceCp must be an integer in [-32000, 32000]');
  const fen = Corpus.validateSourceState(raw.fen).fen4;
  return {
    schema: raw.schema,
    recordId: raw.recordId,
    sourceGameId: raw.sourceGameId,
    fen,
    eco: raw.eco,
    openingFamily: raw.openingFamily,
    initialBalanceCp: raw.initialBalanceCp,
    boardCluster: Corpus.clusterKey(fen),
    positionFamily: Corpus.positionFamilyKey(fen)
  };
}

async function readCandidates(file) {
  const records = [];
  const recordIds = new Set();
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({
    input,
    crlfDelay: Infinity
  });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber++;
    if (!line.trim()) continue;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch (error) {
      fail('candidate line ' + lineNumber + ' is invalid JSON: ' +
        String(error && error.message || error));
    }
    const candidate = validateCandidate(raw, lineNumber);
    assert(!recordIds.has(candidate.recordId),
      'duplicate candidate recordId at line ' + lineNumber + ': ' +
        candidate.recordId);
    recordIds.add(candidate.recordId);
    records.push(candidate);
  }
  assert(records.length > 0, 'candidate file contains no records');
  return records;
}

class UnionFind {
  constructor(size) {
    this.parent = Array.from({ length: size }, function (_, index) {
      return index;
    });
    this.rank = new Uint8Array(size);
  }

  find(value) {
    let root = value;
    while (this.parent[root] !== root) root = this.parent[root];
    while (this.parent[value] !== value) {
      const next = this.parent[value];
      this.parent[value] = root;
      value = next;
    }
    return root;
  }

  union(left, right) {
    let a = this.find(left);
    let b = this.find(right);
    if (a === b) return;
    if (this.rank[a] < this.rank[b]) [a, b] = [b, a];
    this.parent[b] = a;
    if (this.rank[a] === this.rank[b]) this.rank[a]++;
  }
}

function balanceBucket(cp) {
  if (cp < -100) return 'lt-m100';
  if (cp < -30) return 'm100-m31';
  if (cp <= 30) return 'm30-p30';
  if (cp <= 100) return 'p31-p100';
  return 'gt-p100';
}

function buildComponents(records) {
  assert(Array.isArray(records) && records.length > 0,
    'candidate records are required');
  const union = new UnionFind(records.length);
  const firstBoard = new Map();
  const firstGame = new Map();
  records.forEach(function (record, index) {
    const boardPrior = firstBoard.get(record.boardCluster);
    if (boardPrior == null) firstBoard.set(record.boardCluster, index);
    else union.union(index, boardPrior);
    const gamePrior = firstGame.get(record.sourceGameId);
    if (gamePrior == null) firstGame.set(record.sourceGameId, index);
    else union.union(index, gamePrior);
  });

  const grouped = new Map();
  records.forEach(function (record, index) {
    const root = union.find(index);
    if (!grouped.has(root)) grouped.set(root, []);
    grouped.get(root).push(record);
  });

  const components = [];
  grouped.forEach(function (members) {
    const boardClusters = Array.from(new Set(members.map(function (record) {
      return record.boardCluster;
    }))).sort();
    const positionFamilies = Array.from(new Set(members.map(function (record) {
      return record.positionFamily;
    }))).sort();
    if (boardClusters.includes(INCIDENT_CLUSTER) ||
        positionFamilies.includes(INCIDENT_FAMILY)) {
      return;
    }
    const clusterId = boardClusters[0];
    const representatives = members.filter(function (record) {
      return record.boardCluster === clusterId;
    }).slice().sort(function (left, right) {
      return left.fen.localeCompare(right.fen) ||
        left.recordId.localeCompare(right.recordId);
    });
    const representative = representatives[0];
    const sourceRecordIds = Array.from(new Set(members.map(function (record) {
      return record.recordId;
    }))).sort();
    const sourceGameIds = Array.from(new Set(members.map(function (record) {
      return record.sourceGameId;
    }))).sort();
    const clusterMembers = Array.from(new Set(members.map(function (record) {
      return record.fen;
    }))).sort();
    const opening = {
      clusterId,
      openingId: 'op-' + clusterId,
      fen: representative.fen,
      eco: representative.eco,
      openingFamily: representative.openingFamily,
      initialBalanceCp: representative.initialBalanceCp,
      sourceRecordIds,
      clusterMembers
    };
    const identity = {
      boardClusters,
      positionFamilies,
      sourceGameIds,
      sourceRecordIds
    };
    components.push({
      clusterId,
      positionFamilies,
      sourceGameIds,
      opening,
      stratum: [
        opening.eco,
        opening.openingFamily,
        balanceBucket(opening.initialBalanceCp)
      ].join('\u0000'),
      selectionKey: E4.canonicalSha256(identity)
    });
  });
  components.sort(function (left, right) {
    return left.clusterId.localeCompare(right.clusterId);
  });
  return components;
}

function selectStratified(components, count, domain, state) {
  assert(Number.isSafeInteger(count) && count > 0,
    'stratified selection count must be positive');
  const buckets = new Map();
  components.forEach(function (component) {
    if (state.componentIds.has(component.clusterId) ||
        component.positionFamilies.some(function (family) {
          return state.positionFamilies.has(family);
        }) ||
        component.sourceGameIds.some(function (game) {
          return state.sourceGameIds.has(game);
        })) return;
    if (!buckets.has(component.stratum)) buckets.set(component.stratum, []);
    buckets.get(component.stratum).push(component);
  });
  const orderedBuckets = Array.from(buckets.entries()).map(function (entry) {
    const rows = entry[1].slice().sort(function (left, right) {
      const leftKey = E4.sha256(domain + '\nrow\n' + left.selectionKey);
      const rightKey = E4.sha256(domain + '\nrow\n' + right.selectionKey);
      return leftKey.localeCompare(rightKey) ||
        left.clusterId.localeCompare(right.clusterId);
    });
    return {
      stratum: entry[0],
      order: E4.sha256(domain + '\nstratum\n' + entry[0]),
      rows,
      cursor: 0
    };
  }).sort(function (left, right) {
    return left.order.localeCompare(right.order) ||
      left.stratum.localeCompare(right.stratum);
  });

  const selected = [];
  while (selected.length < count) {
    let progressed = false;
    for (const bucket of orderedBuckets) {
      while (bucket.cursor < bucket.rows.length) {
        const component = bucket.rows[bucket.cursor++];
        if (state.componentIds.has(component.clusterId) ||
            component.positionFamilies.some(function (family) {
              return state.positionFamilies.has(family);
            }) ||
            component.sourceGameIds.some(function (game) {
              return state.sourceGameIds.has(game);
            })) continue;
        selected.push(component);
        state.componentIds.add(component.clusterId);
        component.positionFamilies.forEach(function (family) {
          state.positionFamilies.add(family);
        });
        component.sourceGameIds.forEach(function (game) {
          state.sourceGameIds.add(game);
        });
        progressed = true;
        break;
      }
      if (selected.length === count) break;
    }
    if (!progressed) {
      fail('insufficient disjoint opening components for ' + domain +
        ': requested ' + count + ', selected ' + selected.length);
    }
  }
  return selected;
}

function makeState() {
  return {
    componentIds: new Set(),
    positionFamilies: new Set(),
    sourceGameIds: new Set()
  };
}

function commonFreeze(request, sourceSha256, selectorSha256) {
  return {
    immutable: true,
    freezeBaseCommit: request.freezeBaseCommit,
    contentSha256: null,
    openingSetSha256: null,
    assignmentSha256: null,
    sourceArchiveSha256: sourceSha256,
    selectionCodeSha256: selectorSha256,
    stockfishExecutableSha256: request.stockfish.executableSha256,
    stockfishNetworkSha256s: request.stockfish.networkSha256s.slice()
  };
}

function finalizeManifest(manifest, kind) {
  manifest.openingClusters.sort(function (left, right) {
    return left.clusterId.localeCompare(right.clusterId);
  });
  manifest.freeze.openingSetSha256 =
    E4.canonicalSha256(manifest.openingClusters);
  manifest.freeze.assignmentSha256 =
    E4.canonicalSha256(manifest.assignments);
  manifest.manifestId = 'r69-cal-v1/' +
    (kind === 'certification' ? 'cert/' : 'explore/') +
    manifest.freeze.openingSetSha256;
  manifest.freeze.contentSha256 = E4.manifestContentSha256(manifest);
  if (kind === 'certification') E4.validateCertificationManifest(manifest);
  else E4.validateExplorationManifest(manifest);
  return manifest;
}

function appendCertificationSelection(
  manifest, components, count, domain, state, assignment
) {
  const selected = selectStratified(components, count, domain, state);
  selected.forEach(function (component) {
    manifest.openingClusters.push(clone(component.opening));
    manifest.assignments.push(Object.assign({}, assignment, {
      openingClusterId: component.clusterId,
      openingId: component.opening.openingId,
      colors: ['white', 'black'],
      games: 2
    }));
  });
}

function compileManifests(options) {
  const request = options.request;
  const components = options.components;
  const sourceSha256 = options.sourceSha256;
  const selectorSha256 = options.selectorSha256;
  assert(Array.isArray(components) && components.length > 0,
    'opening components are required');
  assertSha(sourceSha256, 'candidate source SHA-256');
  assertSha(selectorSha256, 'selection-code SHA-256');

  const certification = clone(E4.readJson(
    options.certificationTemplate || CERTIFICATION_TEMPLATE));
  certification.status = 'frozen';
  certification.source.release = request.source.release;
  certification.source.url = request.source.url;
  certification.freeze = commonFreeze(
    request, sourceSha256, selectorSha256);
  certification.openingClusters = [];
  certification.assignments = [];

  const state = makeState();
  const masterFirst = [
    E4.LEVELS.find(function (level) { return level.id === 'master'; })
  ].concat(E4.LEVELS.filter(function (level) {
    return level.id !== 'master';
  }));
  masterFirst.forEach(function (level) {
    level.anchors.forEach(function (anchor, index) {
      appendCertificationSelection(
        certification,
        components,
        level.allocation[index],
        'E4-v1/cert/' + level.id + '/' + anchor,
        state,
        {
          scheduleKind: 'cert',
          levelOrPair: level.id,
          anchor
        });
    });
  });
  E4.ADJACENT.forEach(function (pair) {
    appendCertificationSelection(
      certification,
      components,
      400,
      'E4-v1/adjacent/' + pair.pair + '/direct',
      state,
      {
        scheduleKind: 'adjacent',
        levelOrPair: pair.pair,
        anchor: 'direct'
      });
  });
  finalizeManifest(certification, 'certification');

  const exploration = clone(E4.readJson(
    options.explorationTemplate || EXPLORATION_TEMPLATE));
  exploration.status = 'frozen';
  exploration.source.name = request.source.name;
  exploration.source.release = request.source.release;
  exploration.source.url = request.source.url;
  exploration.freeze = commonFreeze(
    request, sourceSha256, selectorSha256);
  exploration.openingClusters = [];
  exploration.assignments = [];
  exploration.schedules.forEach(function (schedule, index) {
    const requestSchedule = request.exploration[index];
    schedule.anchorAllocation = requestSchedule.anchorAllocation.map(
      function (allocation) {
        return {
          elo: allocation.elo,
          openingClusters: allocation.openingClusters,
          games: allocation.openingClusters * 2
        };
      });
    schedule.openingClusters = schedule.anchorAllocation.reduce(
      function (sum, allocation) {
        return sum + allocation.openingClusters;
      }, 0);
    schedule.games = schedule.openingClusters * 2;
    schedule.anchorAllocation.forEach(function (allocation) {
      const selected = selectStratified(
        components,
        allocation.openingClusters,
        'E4-v1/explore/' + schedule.level + '/' + allocation.elo,
        state);
      selected.forEach(function (component) {
        exploration.openingClusters.push(clone(component.opening));
        exploration.assignments.push({
          level: schedule.level,
          anchor: allocation.elo,
          openingClusterId: component.clusterId,
          openingId: component.opening.openingId,
          colors: ['white', 'black'],
          games: 2
        });
      });
    });
  });
  finalizeManifest(exploration, 'exploration');
  E4.validateManifestSet(exploration, certification);
  return { exploration, certification };
}

function writeJsonPair(explorationPath, certificationPath, manifests) {
  const paths = [
    path.resolve(explorationPath),
    path.resolve(certificationPath)
  ];
  assert(paths[0] !== paths[1],
    'exploration and certification outputs must be different files');
  paths.forEach(function (file) {
    assert(!fs.existsSync(file), 'refusing to overwrite existing output: ' + file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
  });
  const bytes = [
    JSON.stringify(manifests.exploration, null, 2) + '\n',
    JSON.stringify(manifests.certification, null, 2) + '\n'
  ];
  const created = [];
  try {
    fs.writeFileSync(paths[0], bytes[0], { flag: 'wx' });
    created.push(paths[0]);
    fs.writeFileSync(paths[1], bytes[1], { flag: 'wx' });
    created.push(paths[1]);
  } catch (error) {
    created.forEach(function (file) {
      try {
        fs.unlinkSync(file);
      } catch (_) {
        // Best-effort rollback of files created by this invocation only.
      }
    });
    throw error;
  }
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    assert(/^--/.test(key), 'unexpected argument: ' + key);
    assert(index + 1 < argv.length, 'missing value for ' + key);
    assert(!Object.prototype.hasOwnProperty.call(values, key),
      'duplicate argument: ' + key);
    values[key] = argv[++index];
  }
  const allowed = new Set([
    '--candidates', '--request', '--exploration-out', '--certification-out'
  ]);
  Object.keys(values).forEach(function (key) {
    assert(allowed.has(key), 'unknown argument: ' + key);
  });
  allowed.forEach(function (key) {
    assert(typeof values[key] === 'string', 'required argument missing: ' + key);
  });
  return values;
}

async function run(argv, root) {
  const args = parseArgs(argv);
  const sourceSha256 = await sha256File(args['--candidates']);
  const requestRaw = JSON.parse(fs.readFileSync(args['--request'], 'utf8'));
  const request = validateRequest(requestRaw, sourceSha256, root || ROOT);
  const candidates = await readCandidates(args['--candidates']);
  const components = buildComponents(candidates);
  const manifests = compileManifests({
    request,
    components,
    sourceSha256,
    selectorSha256: selectionCodeSha256(root || ROOT)
  });
  writeJsonPair(
    args['--exploration-out'], args['--certification-out'], manifests);
  return {
    candidateRecords: candidates.length,
    eligibleComponents: components.length,
    explorationOpeningClusters: manifests.exploration.openingClusters.length,
    certificationOpeningClusters: manifests.certification.openingClusters.length,
    sourceSha256,
    selectionCodeSha256: manifests.certification.freeze.selectionCodeSha256,
    explorationContentSha256:
      manifests.exploration.freeze.contentSha256,
    certificationContentSha256:
      manifests.certification.freeze.contentSha256
  };
}

module.exports = Object.freeze({
  CANDIDATE_KEYS,
  REQUEST_KEYS,
  SELECTOR_CONTRACT_PATHS,
  INCIDENT_CLUSTER,
  INCIDENT_FAMILY,
  validateHeldoutIdentity,
  loadHeldoutIdentity,
  sha256File,
  selectionCodeSha256,
  loadTeacherIdentity,
  validateRequest,
  validateCandidate,
  readCandidates,
  balanceBucket,
  buildComponents,
  selectStratified,
  compileManifests,
  writeJsonPair,
  parseArgs,
  run
});

if (require.main === module) {
  run(process.argv.slice(2)).then(function (summary) {
    console.log(JSON.stringify(summary, null, 2));
  }).catch(function (error) {
    console.error('FAIL: ' + String(error && error.stack || error));
    process.exitCode = 1;
  });
}
