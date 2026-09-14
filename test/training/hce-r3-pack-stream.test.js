#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const Label = require('./label-stockfish');
const Stream = require('./hce-r3-pack-stream');

const contracts = Label.loadFrozenContracts();
const frozen = contracts.teacher;
let checks = 0;

function teacherRecord() {
  return {
    teacher: {
      id: frozen.id,
      release: frozen.engine.release,
      commit: frozen.engine.sourceCommit,
      manifestSha256: contracts.teacherSha256,
      nodes: frozen.search.nodeLimit,
      cpWhite: 25,
      wdlWhite: [500, 300, 200],
      targetWhite: 0.65,
      bestMoveUci: 'a2a3',
      pvUci: ['a2a3', 'a7a6'],
      depth: 15,
      seldepth: 22,
      scoreNodes: 61564,
      reportedNodes: 100054
    }
  };
}

function rejected(mutator) {
  const record = teacherRecord();
  mutator(record.teacher);
  assert.throws(
    () => Stream.exactTeacher(record, contracts),
    /frozen label contract/
  );
  checks++;
}

Stream.exactTeacher(teacherRecord(), contracts);
checks++;
rejected(teacher => { teacher.targetWhite = 0.66; });
rejected(teacher => { teacher.scoreNodes = teacher.reportedNodes + 1; });
rejected(teacher => {
  teacher.reportedNodes = frozen.search.nodeLimit - 1;
});
rejected(teacher => { teacher.scoreBound = 'upperbound'; });

const ids = ['f', '1', 'a', '0', '7'].map(value => value.repeat(64));
const heap = [];
for (const id of ids) Stream.heapPush(heap, { record: { id } });
const ordered = [];
while (heap.length) ordered.push(Stream.heapPop(heap).record.id);
assert.deepStrictEqual(ordered, ids.slice().sort());
checks++;

assert.deepStrictEqual(
  Stream.parseArgs([
    '--input', 'first.ndjson', '--input', 'second.ndjson',
    '--role', 'shared-train'
  ]),
  {
    input: ['first.ndjson', 'second.ndjson'],
    role: 'shared-train',
    sampleOnly: false
  }
);
checks++;

assert.deepStrictEqual(
  Stream.parseArgs([
    '--sample-only', 'true',
    '--role', 'hce-validation',
    '--input', 'sample.ndjson'
  ]),
  {
    input: ['sample.ndjson'],
    role: 'hce-validation',
    sampleOnly: true
  }
);
checks++;

assert.throws(
  () => Stream.parseArgs([
    '--input', 'sample.ndjson',
    '--role', 'shared-train',
    '--sample-only', 'false'
  ]),
  /must be exactly true/
);
checks++;

assert.strictEqual(Stream.sampleOnlyOption({}), false);
assert.strictEqual(Stream.sampleOnlyOption({ sampleOnly: true }), true);
assert.throws(
  () => Stream.sampleOnlyOption({ sampleOnly: 'true' }),
  /direct option must be boolean/
);
checks += 3;

const mechanismFixture = {
  officialEvaluationSnapshot: false,
  fitAllowed: false,
  status: 'sample-only-not-fit-eligible'
};
assert.strictEqual(
  Stream.exactMechanismFixture(mechanismFixture),
  true
);
assert.strictEqual(
  Stream.exactMechanismFixture(Object.assign(
    { note: 'not exact' }, mechanismFixture)),
  false
);
checks += 2;

assert.deepStrictEqual(Stream.streamDisposition(false), {
  status: 'authenticated-production-input',
  mode: 'production',
  sampleOnly: false
});
assert.deepStrictEqual(Stream.streamDisposition(true), {
  status: 'sample-only-not-fit-eligible',
  mode: 'sample-only',
  sampleOnly: true,
  fitAllowed: false,
  officialEvaluationSnapshot: false
});
checks += 2;

const sourceSha256 = 'a'.repeat(64);
const sourceContext = {
  sourceSha256,
  manifest: { source: { license: 'CC0-1.0' } }
};
const productionSource = {
  dataset: 'lichess-evaluated-positions',
  snapshotSha256: sourceSha256,
  license: 'CC0-1.0'
};
const sampleSource = {
  dataset: 'chessy-training-mechanism-fixture',
  snapshotSha256: sourceSha256,
  license: 'CC0-1.0',
  mechanismFixture
};
Stream.validateTeacherSource(productionSource, sourceContext);
Stream.validateTeacherSource(
  sampleSource,
  Object.assign({ sampleOnly: true }, sourceContext)
);
assert.throws(
  () => Stream.validateTeacherSource(
    Object.assign({}, productionSource, { mechanismFixture }),
    sourceContext
  ),
  /selection mode/
);
assert.throws(
  () => Stream.validateTeacherSource(
    {
      dataset: sampleSource.dataset,
      snapshotSha256: sampleSource.snapshotSha256,
      license: sampleSource.license
    },
    Object.assign({ sampleOnly: true }, sourceContext)
  ),
  /selection mode/
);
assert.throws(
  () => Stream.validateTeacherSource(
    Object.assign({}, sampleSource, {
      mechanismFixture: Object.assign({ extra: true }, mechanismFixture)
    }),
    Object.assign({ sampleOnly: true }, sourceContext)
  ),
  /selection mode/
);
checks += 5;

const selectionBinding = {
  sideSelection: {
    sha256: '1'.repeat(64),
    selectionContractSha256: '2'.repeat(64),
    certificationStatus: 'frozen'
  },
  sideShard: {
    sha256: '3'.repeat(64),
    rows: 7
  },
  context: {
    manifestSha256: '1'.repeat(64),
    inputSha256: '3'.repeat(64),
    manifest: {
      adapter: { selectionContractSha256: '2'.repeat(64) }
    },
    shard: { rows: 7 },
    certification: { status: 'frozen' }
  }
};
Stream.validateSelectionBinding(
  selectionBinding.sideSelection,
  selectionBinding.sideShard,
  selectionBinding.context
);
assert.throws(
  () => Stream.validateSelectionBinding(
    selectionBinding.sideSelection,
    selectionBinding.sideShard,
    Object.assign({}, selectionBinding.context, {
      manifestSha256: '4'.repeat(64)
    })
  ),
  /selection shard sidecar binding failed/
);
assert.throws(
  () => Stream.validateSelectionBinding(
    selectionBinding.sideSelection,
    selectionBinding.sideShard,
    Object.assign({}, selectionBinding.context, { certification: null })
  ),
  /selection shard sidecar binding failed/
);
checks += 3;

const productionSidecar = {
  state: 'pinned-teacher-labels',
  input: {
    selectionManifest: { certificationStatus: 'frozen' }
  }
};
const productionContext = {
  manifest: {
    state: 'exploration-selection-only',
    finalFitAllowed: false
  },
  certification: { status: 'frozen' }
};
Stream.validateSidecarMode(productionSidecar, false);
Stream.validateSelectionMode(
  productionSidecar, productionContext, false);
checks += 2;

const sampleSidecar = {
  state: 'pinned-teacher-labels-sample-only',
  fitAllowed: false,
  mechanismFixture,
  input: {
    selectionManifest: {
      certificationStatus: 'awaiting-opening-freeze'
    }
  }
};
const sampleContext = {
  sampleOnly: true,
  manifest: {
    state: 'mechanism-test-selection-only',
    finalFitAllowed: false,
    mechanismFixture
  },
  certification: { status: 'awaiting-opening-freeze' }
};
Stream.validateSidecarMode(sampleSidecar, true);
Stream.validateSelectionMode(sampleSidecar, sampleContext, true);
checks += 2;

assert.throws(
  () => Stream.validateSidecarMode(sampleSidecar, false),
  /production teacher sidecar/
);
assert.throws(
  () => Stream.validateSidecarMode(
    Object.assign({ fitAllowed: true }, productionSidecar),
    false
  ),
  /production teacher sidecar/
);
assert.throws(
  () => Stream.validateSidecarMode(productionSidecar, true),
  /sample-only teacher sidecar/
);
assert.throws(
  () => Stream.validateSidecarMode(Object.assign({}, sampleSidecar, {
    mechanismFixture: Object.assign(
      { untrusted: true }, mechanismFixture)
  }), true),
  /mechanism marker differs/
);
assert.throws(
  () => Stream.validateSelectionMode(
    sampleSidecar,
    {
      manifest: Object.assign({}, sampleContext.manifest, {
        state: 'exploration-selection-only'
      }),
      certification: sampleContext.certification
    },
    true
  ),
  /sample-only selection/
);
assert.throws(
  () => Stream.validateSelectionMode(
    sampleSidecar,
    {
      manifest: sampleContext.manifest,
      certification: { status: 'frozen' }
    },
    true
  ),
  /sample-only selection/
);
checks += 6;

function provenanceEntry(overrides) {
  return Object.assign({
    selectionManifestSha256: '1'.repeat(64),
    selectionContractSha256: '2'.repeat(64),
    sourceSnapshotSha256: '3'.repeat(64)
  }, overrides);
}

assert.deepStrictEqual(
  Stream.sharedProvenance([provenanceEntry(), provenanceEntry()]),
  {
    selectionManifestSha256: '1'.repeat(64),
    selectionContractSha256: '2'.repeat(64),
    sourceSnapshotSha256: '3'.repeat(64)
  }
);
checks++;

assert.throws(
  () => Stream.sharedProvenance([
    provenanceEntry(),
    provenanceEntry({ selectionManifestSha256: '4'.repeat(64) })
  ]),
  /one selection manifest and contract/
);
checks++;

assert.throws(
  () => Stream.sharedProvenance([
    provenanceEntry(),
    provenanceEntry({ sourceSnapshotSha256: '5'.repeat(64) })
  ]),
  /one source snapshot/
);
checks++;

const inventoryManifestPath = path.resolve(
  '/frozen/selection/manifest.json');
const declaredSelectionShards = [0, 1].map(index => ({
  path: 'selection-' + String(index).padStart(3, '0') + '.ndjson',
  rows: index + 7,
  canonicalNdjsonSha256: String(index + 1).repeat(64)
}));
function inventoryEntry(index, overrides) {
  const shard = declaredSelectionShards[index];
  const manifestPath = overrides && overrides.manifestPath ||
    inventoryManifestPath;
  return {
    context: {
      manifestPath,
      manifest: { shards: declaredSelectionShards }
    },
    selectionShard: Object.assign({
      index,
      path: path.resolve(path.dirname(manifestPath), shard.path),
      rows: shard.rows,
      sha256: shard.canonicalNdjsonSha256
    }, overrides && overrides.selectionShard)
  };
}

assert.deepStrictEqual(
  Stream.selectionInventory(
    [inventoryEntry(1), inventoryEntry(0)], false),
  {
    scope: 'complete-selection-shard-inventory',
    declared: declaredSelectionShards.map((shard, index) => ({
      index,
      path: path.resolve(path.dirname(inventoryManifestPath), shard.path),
      rows: shard.rows,
      sha256: shard.canonicalNdjsonSha256
    }))
  }
);
checks++;

assert.throws(
  () => Stream.selectionInventory([inventoryEntry(0)], false),
  /complete selection shard inventory/
);
assert.throws(
  () => Stream.selectionInventory(
    [inventoryEntry(0), inventoryEntry(0)], false),
  /uniquely cover/
);
assert.throws(
  () => Stream.selectionInventory([
    inventoryEntry(0),
    inventoryEntry(1, {
      selectionShard: {
        path: '/frozen/selection/replaced.ndjson'
      }
    })
  ], false),
  /does not match its declared selection shard/
);
assert.throws(
  () => Stream.selectionInventory([
    inventoryEntry(0),
    inventoryEntry(1, {
      manifestPath: '/separate/selection/manifest.json'
    })
  ], false),
  /one selection manifest file/
);
checks += 4;

assert.strictEqual(
  Stream.selectionInventory([inventoryEntry(0)], true).scope,
  'provided-teacher-shards-only',
  'sample-only mechanism streams retain subset validation behavior'
);
checks++;

console.log(checks + ' HCE pack-stream contract checks passed');
