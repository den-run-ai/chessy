#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const E4 = require('./e4-protocol.js');
const Compiler = require('./prepare-e4-opening-candidates.js');
const Label = require('../training/label-stockfish.js');

const ROOT = path.join(__dirname, '..', '..');
const SCHEMA_DIRECTORY = path.join(ROOT, 'eval', 'e4');
const SCHEMA_FILES = [
  'opening-candidate-source.schema.json',
  'opening-candidate.schema.json',
  'opening-candidate-sidecar.schema.json',
  'freeze-request.schema.json'
];
const MAX_SAFE_INTEGER = 9007199254740991;

let checks = 0;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function fail(location, message) {
  throw new Error(location + ': ' + message);
}

function resolvePointer(root, reference) {
  if (!reference.startsWith('#/')) {
    throw new Error('test validator only accepts local JSON pointers: ' +
      reference);
  }
  return reference.slice(2).split('/').reduce(function (value, token) {
    const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!value || !Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error('unresolved schema reference: ' + reference);
    }
    return value[key];
  }, root);
}

/*
 * Small hermetic evaluator for the assertion keywords used by these four
 * schemas. It is intentionally not a general JSON Schema implementation.
 */
function validate(schema, value, root, location) {
  const where = location || '$';
  const document = root || schema;
  if (schema.$ref) {
    validate(resolvePointer(document, schema.$ref), value, document, where);
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'const') &&
      !same(value, schema.const)) {
    fail(where, 'const mismatch');
  }
  if (schema.enum && !schema.enum.some(function (entry) {
    return same(value, entry);
  })) {
    fail(where, 'value is not in enum');
  }
  if (schema.allOf) {
    schema.allOf.forEach(function (entry) {
      validate(entry, value, document, where);
    });
  }

  if (schema.type === 'object') {
    if (value == null || typeof value !== 'object' ||
        Array.isArray(value)) {
      fail(where, 'expected object');
    }
    (schema.required || []).forEach(function (key) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        fail(where, 'missing required property ' + key);
      }
    });
    const properties = schema.properties || {};
    Object.keys(value).forEach(function (key) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        validate(properties[key], value[key], document, where + '.' + key);
      } else if (schema.additionalProperties === false) {
        fail(where, 'unexpected property ' + key);
      }
    });
  }

  if (schema.type === 'array' || schema.items !== undefined ||
      schema.prefixItems || schema.minItems != null ||
      schema.maxItems != null) {
    if (!Array.isArray(value)) fail(where, 'expected array');
    if (schema.minItems != null && value.length < schema.minItems) {
      fail(where, 'too few items');
    }
    if (schema.maxItems != null && value.length > schema.maxItems) {
      fail(where, 'too many items');
    }
    const prefix = schema.prefixItems || [];
    prefix.forEach(function (itemSchema, index) {
      if (index < value.length) {
        validate(itemSchema, value[index], document,
          where + '[' + index + ']');
      }
    });
    if (schema.items === false && value.length > prefix.length) {
      fail(where, 'items beyond prefixItems are forbidden');
    } else if (schema.items && schema.items !== false) {
      const first = prefix.length;
      for (let index = first; index < value.length; index++) {
        validate(schema.items, value[index], document,
          where + '[' + index + ']');
      }
    }
  }

  if (schema.contains) {
    if (!Array.isArray(value)) fail(where, 'contains requires an array');
    let matches = 0;
    value.forEach(function (item, index) {
      try {
        validate(schema.contains, item, document,
          where + '[' + index + ']');
        matches++;
      } catch (_) {
        // A non-match is expected for the other allowed anchors.
      }
    });
    const minimum = schema.minContains == null ? 1 : schema.minContains;
    const maximum = schema.maxContains == null ?
      Number.POSITIVE_INFINITY : schema.maxContains;
    if (matches < minimum || matches > maximum) {
      fail(where, 'contains match count is outside its bounds');
    }
  }

  if (schema.type === 'string') {
    if (typeof value !== 'string') fail(where, 'expected string');
    if (schema.minLength != null && value.length < schema.minLength) {
      fail(where, 'string is too short');
    }
    if (schema.maxLength != null && value.length > schema.maxLength) {
      fail(where, 'string is too long');
    }
    if (schema.pattern && !(new RegExp(schema.pattern, 'u')).test(value)) {
      fail(where, 'string does not match pattern');
    }
  }

  if (schema.type === 'integer') {
    if (!Number.isInteger(value)) fail(where, 'expected integer');
  }
  if (schema.minimum != null && value < schema.minimum) {
    fail(where, 'number is below minimum');
  }
  if (schema.maximum != null && value > schema.maximum) {
    fail(where, 'number is above maximum');
  }

  /*
   * A schema may add object-property constraints beside a draft-2020-12
   * $ref. Evaluate those constraints even when the sibling omits type.
   */
  if (schema.type !== 'object' && schema.properties &&
      value != null && typeof value === 'object' &&
      !Array.isArray(value)) {
    Object.keys(schema.properties).forEach(function (key) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        validate(schema.properties[key], value[key], document,
          where + '.' + key);
      }
    });
  }
}

function loadSchema(filename) {
  const schema = JSON.parse(fs.readFileSync(
    path.join(SCHEMA_DIRECTORY, filename), 'utf8'));
  assert.strictEqual(
    schema.$schema,
    'https://json-schema.org/draft/2020-12/schema',
    filename + ' must declare draft 2020-12'
  );
  checks++;
  return schema;
}

function assertClosedObjectSchemas(value, location) {
  if (!value || typeof value !== 'object') return;
  if (!Array.isArray(value) && value.type === 'object') {
    assert.strictEqual(
      value.additionalProperties,
      false,
      location + ' object schema must set additionalProperties:false'
    );
    checks++;
  }
  Object.keys(value).forEach(function (key) {
    assertClosedObjectSchemas(value[key], location + '/' + key);
  });
}

function accepts(schema, value, message) {
  assert.doesNotThrow(function () {
    validate(schema, value);
  }, message);
  checks++;
}

function rejects(schema, value, message) {
  assert.throws(function () {
    validate(schema, value);
  }, Error, message);
  checks++;
}

function main() {
  const schemas = {};
  SCHEMA_FILES.forEach(function (filename) {
    schemas[filename] = loadSchema(filename);
    assertClosedObjectSchemas(schemas[filename], filename);
  });

  const policy = Compiler.loadSourcePolicy();
  accepts(
    schemas['opening-candidate-source.schema.json'],
    policy,
    'the checked-in source policy must satisfy its strict schema'
  );
  const changedPolicy = clone(policy);
  changedPolicy.source.archive.url =
    changedPolicy.source.forbiddenSources[0].url;
  rejects(
    schemas['opening-candidate-source.schema.json'],
    changedPolicy,
    'the stale torrent must not satisfy the source schema'
  );

  const candidate = {
    schema: 'chessy.e4.opening-candidate.v1',
    recordId:
      'chessy.e4.lichess-standard-rated.2026-06:candidate:' +
      'a'.repeat(64),
    sourceGameId:
      'chessy.e4.lichess-standard-rated.2026-06:game:' +
      'b'.repeat(64),
    fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/' +
      'PPPP1PPP/RNBQKBNR w KQkq - 0 7',
    eco: 'C20',
    openingFamily: 'King Pawn Game',
    initialBalanceCp: 12
  };
  accepts(
    schemas['opening-candidate.schema.json'],
    candidate,
    'a strict opaque six-field candidate row must satisfy its schema'
  );
  const rawIdCandidate = clone(candidate);
  rawIdCandidate.sourceGameId = 'AbCd1234';
  rejects(
    schemas['opening-candidate.schema.json'],
    rawIdCandidate,
    'a raw Lichess ID must not satisfy the candidate schema'
  );
  const extraCandidate = clone(candidate);
  extraCandidate.username = 'forbidden';
  rejects(
    schemas['opening-candidate.schema.json'],
    extraCandidate,
    'candidate rows must reject undeclared fields'
  );

  const contracts = Label.loadFrozenContracts();
  const sidecar = Compiler.buildSidecar({
    policy,
    contracts,
    dependencies: Compiler.dependencyHashes(),
    outputBytes: Compiler.renderNdjson([candidate]),
    outputPath: '/tmp/e4-opening-candidates.ndjson',
    actualExecutableSha256:
      contracts.teacher.engine.executable.sha256,
    result: {
      rows: [candidate],
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
  accepts(
    schemas['opening-candidate-sidecar.schema.json'],
    sidecar,
    'a sidecar built by the compiler must satisfy its schema'
  );
  const changedTeacher = clone(sidecar);
  changedTeacher.teacher.nodeLimit = 99999;
  rejects(
    schemas['opening-candidate-sidecar.schema.json'],
    changedTeacher,
    'a changed teacher budget must not satisfy the sidecar schema'
  );
  const unknownExclusion = clone(sidecar);
  unknownExclusion.extraction.exclusions.posthoc = 1;
  rejects(
    schemas['opening-candidate-sidecar.schema.json'],
    unknownExclusion,
    'an unregistered exclusion reason must not satisfy the sidecar schema'
  );

  const request = {
    schema: 'chessy.e4.freeze-request.v1',
    freezeBaseCommit: 'c'.repeat(40),
    source: {
      id: 'lichess-standard-rated-pgn',
      name: 'Lichess database',
      release: '2026-06',
      url: policy.source.archive.url,
      license: 'CC0-1.0'
    },
    rawArchiveSha256: policy.source.archive.sha256,
    candidateNdjsonSha256: sidecar.output.sha256,
    candidateManifestSha256: 'd'.repeat(64),
    stockfish: {
      executableSha256:
        contracts.teacher.engine.executable.sha256,
      networkSha256s: contracts.teacher.engine.networks.map(function (entry) {
        return entry.sha256;
      })
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
  accepts(
    schemas['freeze-request.schema.json'],
    request,
    'the preregistered ordered freeze request must satisfy its schema'
  );
  const duplicateAnchor = clone(request);
  duplicateAnchor.exploration[0].anchorAllocation = [
    { elo: 1500, openingClusters: 1 },
    { elo: 1500, openingClusters: 2 }
  ];
  rejects(
    schemas['freeze-request.schema.json'],
    duplicateAnchor,
    'duplicate exploration anchors must not satisfy the request schema'
  );
  const unsafeCount = clone(request);
  unsafeCount.exploration[0].anchorAllocation[0].openingClusters =
    MAX_SAFE_INTEGER + 1;
  rejects(
    schemas['freeze-request.schema.json'],
    unsafeCount,
    'unsafe allocation counts must not satisfy the request schema'
  );

  console.log(checks + ' E4 input-schema checks passed.');
}

main();
