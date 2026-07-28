'use strict';

const assert = require('assert');
const deep = require('./deep-bench.js');

let passed = 0;
function test(name, callback) {
  callback();
  passed++;
  console.log('ok ' + name);
}

function throws(pattern, callback) {
  assert.throws(callback, pattern);
}

function result(nodes, qnodes, overrides) {
  return Object.assign({
    move: 'e2e4',
    score: 12,
    depth: 7,
    attemptedDepth: null,
    nodes: nodes,
    qnodes: qnodes,
    cutoffs: 20,
    researches: 2,
    stopReason: 'max-depth',
    ms: nodes / 1000,
    madMs: 0,
    nps: 1000000,
    qshare: qnodes / nodes,
    sampleMs: [nodes / 1000, nodes / 1000],
    experimentMetrics: null
  }, overrides || {});
}

function row(name, candidateNodes, referenceNodes, overrides) {
  const candidate = result(
    candidateNodes, Math.max(1, Math.round(candidateNodes / 2)));
  const reference = result(
    referenceNodes, Math.max(1, Math.round(referenceNodes / 2)));
  const value = {
    name: name,
    family: name.replace(/ mirrored$/, ''),
    mirrored: / mirrored$/.test(name),
    fen: '8/8/8/8/8/8/4K3/7k w - - 0 1',
    candidate: candidate,
    reference: reference,
    ratios: {
      nodes: candidate.nodes / reference.nodes,
      qnodes: candidate.qnodes / reference.qnodes,
      nps: 1,
      wallMs: candidate.nodes / reference.nodes
    },
    divergence: { move: false, score: false, depth: false }
  };
  if (overrides) {
    if (overrides.candidate) Object.assign(candidate, overrides.candidate);
    if (overrides.reference) Object.assign(reference, overrides.reference);
    if (overrides.ratios) Object.assign(value.ratios, overrides.ratios);
    if (overrides.divergence) {
      Object.assign(value.divergence, overrides.divergence);
    }
  }
  return value;
}

test('parses the complete default protocol', function () {
  const options = deep.parseOptions([
    '--candidate', 'candidate.wasm',
    '--reference', 'reference.wasm'
  ]);
  assert.strictEqual(options.depth, 7);
  assert.strictEqual(options.fixedPairs, 2);
  assert.strictEqual(options.depth8Count, 4);
  assert.strictEqual(options.timeMs, 5000);
  assert.strictEqual(options.timePairs, 2);
});

test('rejects unbalanced pair counts and malformed options', function () {
  throws(/must be even/, function () {
    deep.parseOptions([
      '--candidate', 'candidate.wasm',
      '--reference', 'reference.wasm',
      '--fixed-pairs', '3'
    ]);
  });
  throws(/unknown option/, function () {
    deep.parseOptions([
      '--candidate', 'candidate.wasm',
      '--reference', 'reference.wasm',
      '--mystery', '1'
    ]);
  });
  throws(/requires a value/, function () {
    deep.parseOptions([
      '--candidate', 'candidate.wasm',
      '--reference'
    ]);
  });
});

test('computes medians, geomeans, and nearest-rank tails', function () {
  assert.strictEqual(deep.median([9, 1, 5]), 5);
  assert.strictEqual(deep.median([4, 2]), 3);
  assert(Math.abs(deep.geometricMean([2, 8]) - 4) < 1e-12);
  assert.strictEqual(deep.nearestRank([1, 2, 3, 4, 5], 0.9), 5);
  throws(/finite positive/, function () {
    deep.geometricMean([1, 0]);
  });
});

test('classifies an unchanged branch as no activity', function () {
  const exact = row('exact', 100, 100);
  const summary = deep.aggregateFixed([exact]);
  assert.strictEqual(summary.activityPositions, 0);
  assert.strictEqual(summary.gate.code, 'NO-ACTIVITY');
});

test('passes useful fixed-depth work and rejects a 1.25x tail', function () {
  const useful = deep.aggregateFixed([
    row('family-a', 80, 100),
    row('family-b', 70, 100),
    row('family-c', 75, 100)
  ]);
  assert.strictEqual(useful.gate.code, 'PASS-FIXED-DEPTH');
  assert.strictEqual(useful.activityFamilies, 3);

  const tail = deep.aggregateFixed([
    row('family-a', 130, 100, {
      ratios: { wallMs: 0.8, nps: 1.1 }
    }),
    row('family-b', 50, 100, {
      ratios: { wallMs: 0.6, nps: 1.1 }
    }),
    row('family-c', 50, 100, {
      ratios: { wallMs: 0.6, nps: 1.1 }
    })
  ]);
  assert.strictEqual(tail.gate.code, 'REJECT-FIXED-DEPTH');
  assert(tail.gate.reasons.some(function (reason) {
    return /1\.25x/.test(reason);
  }));
});

test('reports divergent improvements without requiring exact parity', function () {
  const summary = deep.aggregateFixed([
    row('changed-a', 70, 100, {
      candidate: { move: 'd2d4' },
      divergence: { move: true }
    }),
    row('changed-b', 70, 100),
    row('changed-c', 70, 100)
  ]);
  assert.strictEqual(summary.gate.code, 'REVIEW-DIVERGENCES');
  const decision = deep.finalDecision(summary.gate, {
    deeper: 3, tied: 2, shallower: 1
  });
  assert.strictEqual(decision.code, 'ADVANCE-WITH-DIVERGENCE-REVIEW');
});

test('rejects a candidate that loses the paired time-to-depth screen', function () {
  const decision = deep.finalDecision({
    code: 'PASS-FIXED-DEPTH',
    reasons: [],
    materialNodeBenefit: true,
    hasDivergences: false
  }, {
    deeper: 1,
    tied: 2,
    shallower: 3
  });
  assert.strictEqual(decision.code, 'REJECT-TIME-TO-DEPTH');
});

test('enforces the timed host budget and stop metadata before scoring depth',
  function () {
    const timed = result(500000, 200000, {
      depth: 10,
      attemptedDepth: 11,
      stopReason: 'time-limit',
      ms: 5100
    });
    assert.strictEqual(deep.timedOvershootAllowance(5000), 100);
    deep.assertTimedResult(timed, 'candidate', 5000, 30);

    throws(/host-observed budget.*elapsed 5101ms/, function () {
      deep.assertTimedResult(
        Object.assign({}, timed, { ms: 5101 }),
        'candidate', 5000, 30);
    });
    throws(/inconsistent time-limit depth/, function () {
      deep.assertTimedResult(
        Object.assign({}, timed, { attemptedDepth: 12 }),
        'candidate', 5000, 30);
    });
    throws(/inconsistent time-limit depth/, function () {
      deep.assertTimedResult(
        Object.assign({}, timed, {
          depth: 0,
          attemptedDepth: null
        }),
        'candidate', 5000, 30);
    });
    throws(/inconsistent time-limit depth/, function () {
      deep.assertTimedResult(
        Object.assign({}, timed, {
          depth: 30,
          attemptedDepth: null
        }),
        'candidate', 5000, 30);
    });
    deep.assertTimedResult(
      Object.assign({}, timed, {
        depth: 10,
        attemptedDepth: null
      }),
      'candidate', 5000, 30);
    throws(/invalid timed stopReason "node-limit"/, function () {
      deep.assertTimedResult(
        Object.assign({}, timed, {
          attemptedDepth: 11,
          stopReason: 'node-limit'
        }),
        'candidate', 5000, 30);
    });
    throws(/inconsistent timed max-depth/, function () {
      deep.assertTimedResult(
        Object.assign({}, timed, {
          depth: 29,
          attemptedDepth: null,
          stopReason: 'max-depth'
        }),
        'candidate', 5000, 30);
    });
    throws(/inconsistent timed mate/, function () {
      deep.assertTimedResult(
        Object.assign({}, timed, {
          score: 12,
          depth: 8,
          attemptedDepth: null,
          stopReason: 'mate'
        }),
        'candidate', 5000, 30);
    });
  });

test('rejects narrow or marginal activity before strength testing', function () {
  const narrow = deep.aggregateFixed([
    row('active-a', 80, 100),
    row('inactive-b', 100, 100),
    row('inactive-c', 100, 100)
  ]);
  assert.strictEqual(narrow.activityFamilies, 1);
  assert.strictEqual(narrow.gate.code, 'REJECT-LOW-ACTIVITY');

  const marginal = deep.aggregateFixed([
    row('active-a', 98, 100),
    row('active-b', 98, 100),
    row('active-c', 98, 100)
  ]);
  assert.strictEqual(marginal.gate.code, 'PENDING-TIME-BENEFIT');
  const decision = deep.finalDecision(marginal.gate, {
    deeper: 0,
    tied: 6,
    shallower: 0
  });
  assert.strictEqual(decision.code, 'REJECT-MARGINAL-BENEFIT');
});

test('allows a marginal node change only with a stronger paired 5s outcome', function () {
  const marginal = deep.aggregateFixed([
    row('active-a', 98, 100),
    row('active-b', 98, 100),
    row('active-c', 98, 100)
  ]);
  const decision = deep.finalDecision(marginal.gate, {
    deeper: 3,
    tied: 2,
    shallower: 1
  });
  assert.strictEqual(decision.code, 'ADVANCE-TO-STRENGTH');
});

test('aggregates bounded branch-defined experiment counters', function () {
  const rows = [1, 2, 3].map(function (value) {
    const metrics = new Array(16).fill(0);
    metrics[0] = value;
    return row('metric-' + value, 100, 100, {
      candidate: { experimentMetrics: metrics }
    });
  });
  const summary = deep.aggregateFixed(rows);
  assert.strictEqual(summary.activityFamilies, 3);
  assert.deepStrictEqual(
    summary.experimentMetricSums.candidate.slice(0, 3),
    [6, 0, 0]
  );
});

test('pins the two uploaded iPhone witnesses without embedding the PGN', function () {
  assert.strictEqual(deep.WITNESSES.length, 2);
  assert(/18\.\.\.Nb4/.test(deep.WITNESSES[0].name));
  assert(/27\.\.\.Rb8/.test(deep.WITNESSES[1].name));
  assert.strictEqual(
    deep.WITNESSES[0].fen,
    'r2qr1k1/pppb1p1p/2n2p2/7Q/3bN3/3P3P/PP4B1/R1B2R1K b - - 1 18'
  );
});

test('keeps exact depth 8 on the bounded endgame families', function () {
  assert.deepStrictEqual(deep.DEPTH8_FAMILY_INDEXES, [4, 5, 6, 7]);
});

console.log(passed + ' passed');
