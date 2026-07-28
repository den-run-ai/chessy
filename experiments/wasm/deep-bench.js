/*
 * Divergent Rust/WASM deep-search experiment screen.
 *
 * This harness deliberately compares two WASM modules without requiring an
 * exact tree. It is for separately gated search experiments such as LMR, SEE,
 * and verified null move; it does not authorize a production engine change.
 *
 * Usage:
 *   node experiments/wasm/deep-bench.js \
 *     --candidate /path/to/candidate.wasm \
 *     --reference /path/to/origin-main.wasm \
 *     --json report.json --markdown report.md
 *
 * Defaults:
 *   fixed depth 7 over the canonical 18 positions
 *   fixed depth 8 over four tractable endgame positions
 *   two order-balanced candidate/reference pairs at each fixed depth
 *   two order-balanced 5-second pairs over all 18 positions
 *   two additional iPhone A14 witnesses from the 2026-07-28 debug game
 *
 * Performance outcomes are reported, never converted into a failing process
 * exit. Exceptions, malformed inputs, missing fixed-depth completion, or
 * non-deterministic fixed searches do fail the run.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const bench = require('./bench.js');

// Unbounded depth 8 on the middlegame fixtures can fill the engine's fixed
// transposition table before completion. Keep this screen exact by using the
// four bounded endgame families; difficult middlegames and the mobile
// witnesses remain covered by the paired time-to-depth screen.
const DEPTH8_FAMILY_INDEXES = Object.freeze([4, 5, 6, 7]);
const WITNESSES = Object.freeze([
  Object.freeze({
    name: 'iPhone A14 18...Nb4 (83% qshare, d6 at 5s)',
    family: 'iPhone A14 18...Nb4',
    fen: 'r2qr1k1/pppb1p1p/2n2p2/7Q/3bN3/3P3P/PP4B1/R1B2R1K b - - 1 18'
  }),
  Object.freeze({
    name: 'iPhone A14 27...Rb8 (d9 peak at 5s)',
    family: 'iPhone A14 27...Rb8',
    fen: 'r2q2k1/pQp2p1p/6rB/5pN1/3n4/3P3P/PP6/6RK b - - 0 27'
  })
]);

const FIXED_FIELDS = Object.freeze([
  'move', 'score', 'depth', 'attemptedDepth', 'nodes', 'qnodes', 'cutoffs',
  'researches', 'stopReason', 'experimentMetrics'
]);

function canonicalPositions() {
  return bench.POSITIONS.map(function (position, index) {
    return {
      name: position[0],
      family: bench.FAMILIES[Math.floor(index / 2)][0],
      mirrored: index % 2 === 1,
      fen: position[1]
    };
  });
}

function depth8Positions(count) {
  return DEPTH8_FAMILY_INDEXES.slice(0, count).map(function (familyIndex) {
    return {
      name: bench.FAMILIES[familyIndex][0] + ' (depth-8 bounded subset)',
      family: bench.FAMILIES[familyIndex][0],
      mirrored: false,
      fen: bench.FAMILIES[familyIndex][1]
    };
  });
}

function parseOptionMap(argv) {
  const known = new Set([
    'candidate', 'reference', 'candidate-label', 'reference-label', 'depth',
    'fixed-pairs', 'depth8', 'time-ms', 'time-pairs', 'warm-ms', 'json',
    'markdown'
  ]);
  const options = Object.create(null);
  for (let index = 0; index < argv.length; index += 2) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      throw new Error('unexpected positional argument "' + argument + '"');
    }
    const name = argument.slice(2);
    if (!known.has(name)) {
      throw new Error('unknown option --' + name);
    }
    if (Object.prototype.hasOwnProperty.call(options, name)) {
      throw new Error('duplicate option --' + name);
    }
    if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
      throw new Error('--' + name + ' requires a value');
    }
    options[name] = argv[index + 1];
  }
  return options;
}

function integerOption(options, name, fallback, minimum, maximum) {
  const raw = options[name] === undefined ? String(fallback) : options[name];
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error('--' + name + ' must be an integer from ' + minimum +
      ' through ' + maximum + ' (got "' + raw + '")');
  }
  return value;
}

function evenOption(options, name, fallback, minimum, maximum) {
  const value = integerOption(options, name, fallback, minimum, maximum);
  if (value % 2 !== 0) {
    throw new Error('--' + name +
      ' must be even so candidate/reference order balances per position');
  }
  return value;
}

function parseOptions(argv) {
  const options = parseOptionMap(argv);
  if (!options.candidate || !options.reference) {
    throw new Error('--candidate and --reference are required');
  }
  return {
    candidatePath: path.resolve(options.candidate),
    referencePath: path.resolve(options.reference),
    candidateLabel: options['candidate-label'] || 'candidate',
    referenceLabel: options['reference-label'] || 'origin/main',
    depth: integerOption(options, 'depth', 7, 1, 64),
    fixedPairs: evenOption(options, 'fixed-pairs', 2, 2, 10),
    depth8Count: integerOption(
      options, 'depth8', DEPTH8_FAMILY_INDEXES.length, 0,
      DEPTH8_FAMILY_INDEXES.length),
    timeMs: integerOption(options, 'time-ms', 5000, 100, 60000),
    timePairs: evenOption(options, 'time-pairs', 2, 2, 10),
    warmMs: integerOption(options, 'warm-ms', 250, 0, 5000),
    jsonPath: options.json ? path.resolve(options.json) : null,
    markdownPath: options.markdown ? path.resolve(options.markdown) : null
  };
}

function median(values) {
  if (!values.length) throw new Error('median requires at least one value');
  const sorted = values.slice().sort(function (a, b) { return a - b; });
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function geometricMean(values) {
  if (!values.length || values.some(function (value) {
    return !Number.isFinite(value) || value <= 0;
  })) {
    throw new Error('geometric mean requires finite positive values');
  }
  return Math.exp(values.reduce(function (sum, value) {
    return sum + Math.log(value);
  }, 0) / values.length);
}

function nearestRank(sortedValues, quantile) {
  if (!sortedValues.length || quantile <= 0 || quantile > 1) {
    throw new Error('nearestRank requires values and a quantile in (0, 1]');
  }
  return sortedValues[Math.max(
    0, Math.ceil(quantile * sortedValues.length) - 1)];
}

function ratio(candidate, reference, label) {
  if (!Number.isFinite(candidate) || !Number.isFinite(reference) ||
      candidate < 0 || reference < 0) {
    throw new Error(label + ' ratio requires finite non-negative values');
  }
  if (reference === 0) {
    if (candidate === 0) return 1;
    throw new Error(label + ' reference is zero while candidate is non-zero');
  }
  return candidate / reference;
}

function sameMetrics(left, right) {
  if (left === null || right === null) return left === right;
  return left.length === right.length && left.every(function (value, index) {
    return value === right[index];
  });
}

function differences(left, right) {
  return FIXED_FIELDS.filter(function (field) {
    if (field === 'experimentMetrics') {
      return !sameMetrics(left[field], right[field]);
    }
    return left[field] !== right[field];
  });
}

function measuredResult(result) {
  return {
    move: result.move,
    score: result.score,
    depth: result.depth,
    attemptedDepth: result.attemptedDepth,
    nodes: result.nodes,
    qnodes: result.qnodes,
    cutoffs: result.cutoffs,
    researches: result.researches,
    stopReason: result.stopReason,
    ms: result.ms,
    nps: result.ms > 0 ? result.nodes * 1000 / result.ms : null,
    qshare: result.nodes ? result.qnodes / result.nodes : 0,
    experimentMetrics: result.experimentMetrics
  };
}

function summarizeFixed(samples, label) {
  const first = samples[0];
  for (let index = 1; index < samples.length; index++) {
    const changed = differences(samples[index], first);
    if (changed.length) {
      throw new Error(label + ' changed across identical fixed searches: ' +
        changed.join(', '));
    }
  }
  const times = samples.map(function (sample) { return sample.ms; });
  const result = measuredResult(first);
  result.ms = median(times);
  result.madMs = median(times.map(function (value) {
    return Math.abs(value - result.ms);
  }));
  result.nps = result.ms > 0 ? result.nodes * 1000 / result.ms : null;
  result.sampleMs = times;
  return result;
}

function runOrderedPair(candidate, reference, fen, options, candidateFirst) {
  if (candidateFirst) {
    return {
      candidate: candidate.search(fen, options),
      reference: reference.search(fen, options),
      order: 'candidate-reference'
    };
  }
  return {
    reference: reference.search(fen, options),
    candidate: candidate.search(fen, options),
    order: 'reference-candidate'
  };
}

function divergence(candidate, reference) {
  return {
    move: candidate.move !== reference.move,
    score: candidate.score !== reference.score,
    depth: candidate.depth !== reference.depth
  };
}

function fixedPosition(candidate, reference, position, positionIndex, depth, pairs) {
  const options = {
    maxDepth: depth,
    nodeLimit: 0,
    timeMs: 0,
    quiesce: true
  };
  const candidateSamples = [];
  const referenceSamples = [];
  const npsRatios = [];
  const wallRatios = [];
  const orders = [];
  for (let round = 0; round < pairs; round++) {
    const pair = runOrderedPair(
      candidate, reference, position.fen, options,
      (positionIndex + round) % 2 === 0);
    candidateSamples.push(pair.candidate);
    referenceSamples.push(pair.reference);
    npsRatios.push(
      (pair.candidate.nodes / pair.candidate.ms) /
      (pair.reference.nodes / pair.reference.ms));
    wallRatios.push(pair.candidate.ms / pair.reference.ms);
    orders.push(pair.order);
  }
  const candidateResult = summarizeFixed(
    candidateSamples, position.name + ' candidate');
  const referenceResult = summarizeFixed(
    referenceSamples, position.name + ' reference');
  if (candidateResult.depth < depth &&
      candidateResult.stopReason !== 'mate' &&
      candidateResult.stopReason !== 'game-over') {
    throw new Error(position.name + ' candidate did not complete depth ' +
      depth + ': d' + candidateResult.depth + ' ' +
      candidateResult.stopReason);
  }
  if (referenceResult.depth < depth &&
      referenceResult.stopReason !== 'mate' &&
      referenceResult.stopReason !== 'game-over') {
    throw new Error(position.name + ' reference did not complete depth ' +
      depth + ': d' + referenceResult.depth + ' ' +
      referenceResult.stopReason);
  }
  return {
    name: position.name,
    family: position.family,
    mirrored: Boolean(position.mirrored),
    fen: position.fen,
    candidate: candidateResult,
    reference: referenceResult,
    ratios: {
      nodes: ratio(
        candidateResult.nodes, referenceResult.nodes, position.name + ' nodes'),
      qnodes: ratio(
        candidateResult.qnodes, referenceResult.qnodes,
        position.name + ' qnodes'),
      nps: geometricMean(npsRatios),
      wallMs: geometricMean(wallRatios)
    },
    divergence: divergence(candidateResult, referenceResult),
    orders: orders
  };
}

function sumMetrics(rows, side) {
  if (!rows.some(function (row) {
    return Array.isArray(row[side].experimentMetrics);
  })) {
    return null;
  }
  const sums = new Array(bench.EXPERIMENT_METRIC_SLOTS).fill(0);
  for (const row of rows) {
    const metrics = row[side].experimentMetrics;
    if (!metrics) continue;
    for (let index = 0; index < sums.length; index++) {
      sums[index] += metrics[index];
      if (!Number.isSafeInteger(sums[index])) {
        throw new Error(side + ' experiment metric ' + index +
          ' aggregate exceeds JavaScript safe-integer range');
      }
    }
  }
  return sums;
}

function countDivergences(rows) {
  return {
    move: rows.filter(function (row) { return row.divergence.move; }).length,
    score: rows.filter(function (row) { return row.divergence.score; }).length,
    depth: rows.filter(function (row) { return row.divergence.depth; }).length
  };
}

function rowHasActivity(row) {
  const metricActivity = row.candidate.experimentMetrics &&
    row.candidate.experimentMetrics.some(function (value) {
      return value !== 0;
    });
  return Boolean(metricActivity) ||
    FIXED_FIELDS.slice(0, -1).some(function (field) {
      return row.candidate[field] !== row.reference[field];
    });
}

function familyRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.family)) groups.set(row.family, []);
    groups.get(row.family).push(row);
  }
  return Array.from(groups.entries()).map(function (entry) {
    const members = entry[1];
    return {
      name: entry[0],
      positions: members.length,
      ratios: {
        nodes: geometricMean(members.map(function (row) {
          return row.ratios.nodes;
        })),
        qnodes: geometricMean(members.map(function (row) {
          return row.ratios.qnodes;
        })),
        nps: geometricMean(members.map(function (row) {
          return row.ratios.nps;
        })),
        wallMs: geometricMean(members.map(function (row) {
          return row.ratios.wallMs;
        }))
      },
      divergence: countDivergences(members),
      activityPositions: members.filter(rowHasActivity).length
    };
  });
}

function fixedDepthGate(summary) {
  if (summary.activityPositions === 0) {
    return {
      code: 'NO-ACTIVITY',
      reasons: ['candidate tree and experiment counters match the reference'],
      materialNodeBenefit: false,
      hasDivergences: false
    };
  }
  if (summary.activityFamilies < 3) {
    return {
      code: 'REJECT-LOW-ACTIVITY',
      reasons: ['activity reaches only ' + summary.activityFamilies +
        ' canonical family/families; at least 3 are required'],
      materialNodeBenefit: summary.ratios.nodesGeomean <= 0.95,
      hasDivergences: Boolean(
        summary.divergences.move || summary.divergences.score ||
        summary.divergences.depth)
    };
  }
  const reasons = [];
  if (summary.ratios.nodesGeomean >= 1) {
    reasons.push('geomean nodes are not lower than reference');
  }
  if (summary.ratios.wallMsGeomean >= 1) {
    reasons.push('geomean fixed-depth wall time is not lower than reference');
  }
  if (summary.tails.worstPositionNodes.ratio > 1.25) {
    reasons.push('a position exceeds the 1.25x node tail limit');
  }
  if (reasons.length) {
    return {
      code: 'REJECT-FIXED-DEPTH',
      reasons: reasons,
      materialNodeBenefit: summary.ratios.nodesGeomean <= 0.95,
      hasDivergences: Boolean(
        summary.divergences.move || summary.divergences.score ||
        summary.divergences.depth)
    };
  }
  if (summary.divergences.move || summary.divergences.score ||
      summary.divergences.depth) {
    return {
      code: 'REVIEW-DIVERGENCES',
      reasons: ['performance screen passes but move/score/depth changed'],
      materialNodeBenefit: summary.ratios.nodesGeomean <= 0.95,
      hasDivergences: true
    };
  }
  if (summary.ratios.nodesGeomean > 0.95) {
    return {
      code: 'PENDING-TIME-BENEFIT',
      reasons: ['d7 geomean node reduction is below the predeclared 5% floor'],
      materialNodeBenefit: false,
      hasDivergences: false
    };
  }
  return {
    code: 'PASS-FIXED-DEPTH',
    reasons: ['at least 5% lower geomean nodes and wall time with no 1.25x node outlier'],
    materialNodeBenefit: true,
    hasDivergences: false
  };
}

function aggregateFixed(rows) {
  const candidateNodes = rows.reduce(function (sum, row) {
    return sum + row.candidate.nodes;
  }, 0);
  const referenceNodes = rows.reduce(function (sum, row) {
    return sum + row.reference.nodes;
  }, 0);
  const candidateQnodes = rows.reduce(function (sum, row) {
    return sum + row.candidate.qnodes;
  }, 0);
  const referenceQnodes = rows.reduce(function (sum, row) {
    return sum + row.reference.qnodes;
  }, 0);
  const families = familyRows(rows);
  const nodeSorted = rows.slice().sort(function (left, right) {
    return left.ratios.nodes - right.ratios.nodes;
  });
  const npsSorted = rows.slice().sort(function (left, right) {
    return left.ratios.nps - right.ratios.nps;
  });
  const familyNodeSorted = families.slice().sort(function (left, right) {
    return left.ratios.nodes - right.ratios.nodes;
  });
  const familyNpsSorted = families.slice().sort(function (left, right) {
    return left.ratios.nps - right.ratios.nps;
  });
  const divergences = countDivergences(rows);
  const candidateMetrics = sumMetrics(rows, 'candidate');
  const referenceMetrics = sumMetrics(rows, 'reference');
  const activityPositions = rows.filter(rowHasActivity).length;
  const activityFamilies = families.filter(function (family) {
    return family.activityPositions > 0;
  }).length;
  const summary = {
    positions: rows.length,
    families: families,
    totals: {
      candidateNodes: candidateNodes,
      referenceNodes: referenceNodes,
      candidateQnodes: candidateQnodes,
      referenceQnodes: referenceQnodes,
      candidateQshare: candidateNodes ? candidateQnodes / candidateNodes : 0,
      referenceQshare: referenceNodes ? referenceQnodes / referenceNodes : 0
    },
    ratios: {
      totalNodes: ratio(candidateNodes, referenceNodes, 'total nodes'),
      totalQnodes: ratio(candidateQnodes, referenceQnodes, 'total qnodes'),
      nodesGeomean: geometricMean(rows.map(function (row) {
        return row.ratios.nodes;
      })),
      qnodesGeomean: geometricMean(rows.map(function (row) {
        return row.ratios.qnodes;
      })),
      npsGeomean: geometricMean(rows.map(function (row) {
        return row.ratios.nps;
      })),
      wallMsGeomean: geometricMean(rows.map(function (row) {
        return row.ratios.wallMs;
      }))
    },
    tails: {
      worstPositionNodes: {
        name: nodeSorted[nodeSorted.length - 1].name,
        ratio: nodeSorted[nodeSorted.length - 1].ratios.nodes
      },
      p90PositionNodes: {
        name: nearestRank(nodeSorted, 0.9).name,
        ratio: nearestRank(nodeSorted, 0.9).ratios.nodes
      },
      worstFamilyNodes: {
        name: familyNodeSorted[familyNodeSorted.length - 1].name,
        ratio: familyNodeSorted[familyNodeSorted.length - 1].ratios.nodes
      },
      p90FamilyNodes: {
        name: nearestRank(familyNodeSorted, 0.9).name,
        ratio: nearestRank(familyNodeSorted, 0.9).ratios.nodes
      },
      worstPositionNps: {
        name: npsSorted[0].name,
        ratio: npsSorted[0].ratios.nps
      },
      p10PositionNps: {
        name: nearestRank(npsSorted, 0.1).name,
        ratio: nearestRank(npsSorted, 0.1).ratios.nps
      },
      worstFamilyNps: {
        name: familyNpsSorted[0].name,
        ratio: familyNpsSorted[0].ratios.nps
      },
      p10FamilyNps: {
        name: nearestRank(familyNpsSorted, 0.1).name,
        ratio: nearestRank(familyNpsSorted, 0.1).ratios.nps
      }
    },
    divergences: divergences,
    activityPositions: activityPositions,
    activityFamilies: activityFamilies,
    experimentMetricSums: {
      candidate: candidateMetrics,
      reference: referenceMetrics
    }
  };
  summary.gate = fixedDepthGate(summary);
  return summary;
}

function runFixedScreen(candidate, reference, positions, depth, pairs) {
  const rows = positions.map(function (position, index) {
    const row = fixedPosition(
      candidate, reference, position, index, depth, pairs);
    console.log('fixed d' + depth + ' ' + position.name + ': node ' +
      row.ratios.nodes.toFixed(4) + 'x, NPS ' +
      row.ratios.nps.toFixed(4) + 'x, ' +
      (row.divergence.move || row.divergence.score || row.divergence.depth
        ? 'move/score/depth diverges'
        : 'move/score/depth match'));
    return row;
  });
  return { depth: depth, pairs: pairs, rows: rows, summary: aggregateFixed(rows) };
}

function timePosition(candidate, reference, position, positionIndex, config) {
  const warmOptions = {
    maxDepth: 30,
    nodeLimit: 0,
    timeMs: config.warmMs,
    quiesce: true
  };
  const timedOptions = {
    maxDepth: 30,
    nodeLimit: 0,
    timeMs: config.timeMs,
    quiesce: true
  };
  const warm = config.warmMs
    ? runOrderedPair(
      candidate, reference, position.fen, warmOptions,
      positionIndex % 2 === 0)
    : null;
  const runs = [];
  for (let round = 0; round < config.timePairs; round++) {
    const pair = runOrderedPair(
      candidate, reference, position.fen, timedOptions,
      (positionIndex + round) % 2 === 0);
    runs.push({
      round: round,
      order: pair.order,
      candidate: measuredResult(pair.candidate),
      reference: measuredResult(pair.reference),
      divergence: divergence(pair.candidate, pair.reference),
      depthOutcome: pair.candidate.depth > pair.reference.depth
        ? 'candidate-deeper'
        : pair.candidate.depth < pair.reference.depth
          ? 'reference-deeper'
          : 'tied',
      npsRatio: (pair.candidate.nodes / pair.candidate.ms) /
        (pair.reference.nodes / pair.reference.ms)
    });
  }
  const deeper = runs.filter(function (run) {
    return run.depthOutcome === 'candidate-deeper';
  }).length;
  const tied = runs.filter(function (run) {
    return run.depthOutcome === 'tied';
  }).length;
  const shallower = runs.length - deeper - tied;
  return {
    name: position.name,
    family: position.family,
    mirrored: Boolean(position.mirrored),
    fen: position.fen,
    warmup: warm ? {
      order: warm.order,
      candidate: measuredResult(warm.candidate),
      reference: measuredResult(warm.reference)
    } : null,
    summary: {
      pairs: runs.length,
      deeper: deeper,
      tied: tied,
      shallower: shallower,
      candidateMeanDepth: runs.reduce(function (sum, run) {
        return sum + run.candidate.depth;
      }, 0) / runs.length,
      referenceMeanDepth: runs.reduce(function (sum, run) {
        return sum + run.reference.depth;
      }, 0) / runs.length,
      candidateMeanNodes: runs.reduce(function (sum, run) {
        return sum + run.candidate.nodes;
      }, 0) / runs.length,
      referenceMeanNodes: runs.reduce(function (sum, run) {
        return sum + run.reference.nodes;
      }, 0) / runs.length,
      candidateMeanQnodes: runs.reduce(function (sum, run) {
        return sum + run.candidate.qnodes;
      }, 0) / runs.length,
      referenceMeanQnodes: runs.reduce(function (sum, run) {
        return sum + run.reference.qnodes;
      }, 0) / runs.length,
      npsRatio: geometricMean(runs.map(function (run) {
        return run.npsRatio;
      })),
      moveDivergences: runs.filter(function (run) {
        return run.divergence.move;
      }).length,
      scoreDivergences: runs.filter(function (run) {
        return run.divergence.score;
      }).length,
      depthDivergences: runs.filter(function (run) {
        return run.divergence.depth;
      }).length
    },
    runs: runs
  };
}

function aggregateTime(rows, timeMs, pairs) {
  const runs = rows.reduce(function (all, row) {
    return all.concat(row.runs);
  }, []);
  const deeper = runs.filter(function (run) {
    return run.depthOutcome === 'candidate-deeper';
  }).length;
  const tied = runs.filter(function (run) {
    return run.depthOutcome === 'tied';
  }).length;
  const shallower = runs.length - deeper - tied;
  const candidateOvershoots = runs.map(function (run) {
    return run.candidate.ms - timeMs;
  }).sort(function (a, b) { return a - b; });
  const referenceOvershoots = runs.map(function (run) {
    return run.reference.ms - timeMs;
  }).sort(function (a, b) { return a - b; });
  return {
    positions: rows.length,
    pairsPerPosition: pairs,
    runs: runs.length,
    deeper: deeper,
    tied: tied,
    shallower: shallower,
    candidateMeanDepth: runs.reduce(function (sum, run) {
      return sum + run.candidate.depth;
    }, 0) / runs.length,
    referenceMeanDepth: runs.reduce(function (sum, run) {
      return sum + run.reference.depth;
    }, 0) / runs.length,
    npsGeomean: geometricMean(runs.map(function (run) {
      return run.npsRatio;
    })),
    overshootMs: {
      candidate: {
        p50: nearestRank(candidateOvershoots, 0.5),
        p95: nearestRank(candidateOvershoots, 0.95),
        max: candidateOvershoots[candidateOvershoots.length - 1]
      },
      reference: {
        p50: nearestRank(referenceOvershoots, 0.5),
        p95: nearestRank(referenceOvershoots, 0.95),
        max: referenceOvershoots[referenceOvershoots.length - 1]
      }
    }
  };
}

function runTimeScreen(candidate, reference, positions, config) {
  const rows = positions.map(function (position, index) {
    const row = timePosition(
      candidate, reference, position, index, config);
    console.log(config.timeMs + 'ms ' + position.name + ': deeper/tied/' +
      'shallower ' + row.summary.deeper + '/' + row.summary.tied + '/' +
      row.summary.shallower + ', NPS ' +
      row.summary.npsRatio.toFixed(4) + 'x');
    return row;
  });
  return {
    timeMs: config.timeMs,
    pairs: config.timePairs,
    warmMs: config.warmMs,
    rows: rows,
    summary: aggregateTime(rows, config.timeMs, config.timePairs)
  };
}

function finalDecision(fixedGate, timedSummary) {
  if (fixedGate.code === 'NO-ACTIVITY') return fixedGate;
  if (fixedGate.code === 'REJECT-FIXED-DEPTH' ||
      fixedGate.code === 'REJECT-LOW-ACTIVITY') {
    return fixedGate;
  }
  if (timedSummary.shallower > timedSummary.deeper) {
    return {
      code: 'REJECT-TIME-TO-DEPTH',
      reasons: ['candidate is shallower more often than it is deeper at 5 seconds']
    };
  }
  if (!fixedGate.materialNodeBenefit &&
      timedSummary.deeper <= timedSummary.shallower) {
    return {
      code: 'REJECT-MARGINAL-BENEFIT',
      reasons: [
        'd7 geomean node reduction is below 5%',
        'paired 5-second candidate-deeper outcomes do not exceed shallower outcomes'
      ]
    };
  }
  if (fixedGate.hasDivergences) {
    return {
      code: 'ADVANCE-WITH-DIVERGENCE-REVIEW',
      reasons: fixedGate.reasons.concat([
        'run tactics and strength gates before any retention decision'
      ])
    };
  }
  return {
    code: 'ADVANCE-TO-STRENGTH',
    reasons: ['fixed-depth and 5-second screens pass; strength is not established']
  };
}

function fmt(value, digits) {
  return Number.isFinite(value)
    ? value.toFixed(digits === undefined ? 4 : digits)
    : '—';
}

function divergenceMark(row) {
  const labels = [];
  if (row.divergence.move) labels.push('move');
  if (row.divergence.score) labels.push('score');
  if (row.divergence.depth) labels.push('depth');
  return labels.length ? labels.join(', ') : '—';
}

function fixedMarkdown(title, screen) {
  let output = '## ' + title + '\n\n';
  const summary = screen.summary;
  output += '| metric | candidate/reference |\n|---|---:|\n';
  output += '| Total nodes | ' + fmt(summary.ratios.totalNodes) + 'x |\n';
  output += '| Geomean position nodes | ' +
    fmt(summary.ratios.nodesGeomean) + 'x |\n';
  output += '| Geomean position qnodes | ' +
    fmt(summary.ratios.qnodesGeomean) + 'x |\n';
  output += '| Geomean paired NPS | ' +
    fmt(summary.ratios.npsGeomean) + 'x |\n';
  output += '| Geomean wall time | ' +
    fmt(summary.ratios.wallMsGeomean) + 'x |\n';
  output += '| Worst position nodes | ' +
    fmt(summary.tails.worstPositionNodes.ratio) + 'x (' +
    summary.tails.worstPositionNodes.name + ') |\n';
  output += '| p90 position nodes | ' +
    fmt(summary.tails.p90PositionNodes.ratio) + 'x (' +
    summary.tails.p90PositionNodes.name + ') |\n';
  output += '| Worst family nodes | ' +
    fmt(summary.tails.worstFamilyNodes.ratio) + 'x (' +
    summary.tails.worstFamilyNodes.name + ') |\n';
  output += '| Worst family NPS | ' +
    fmt(summary.tails.worstFamilyNps.ratio) + 'x (' +
    summary.tails.worstFamilyNps.name + ') |\n';
  output += '| Move / score / depth divergences | ' +
    summary.divergences.move + ' / ' + summary.divergences.score + ' / ' +
    summary.divergences.depth + ' |\n';
  output += '| Active positions / families | ' + summary.activityPositions +
    ' / ' + summary.activityFamilies + ' |\n';
  output += '| Diagnostic gate | **' + summary.gate.code + '** |\n\n';

  output += '| position | candidate nodes / qnodes | reference nodes / qnodes | node | qnode | NPS | move (cand / ref) | score (cand / ref) | depth (cand / ref) | divergence |\n';
  output += '|---|---:|---:|---:|---:|---:|---|---:|---:|---|\n';
  for (const row of screen.rows) {
    output += '| ' + row.name + ' | ' + row.candidate.nodes + ' / ' +
      row.candidate.qnodes + ' | ' + row.reference.nodes + ' / ' +
      row.reference.qnodes + ' | ' + fmt(row.ratios.nodes) + 'x | ' +
      fmt(row.ratios.qnodes) + 'x | ' + fmt(row.ratios.nps) + 'x | ' +
      row.candidate.move + ' / ' + row.reference.move + ' | ' +
      row.candidate.score + ' / ' + row.reference.score + ' | ' +
      row.candidate.depth + ' / ' + row.reference.depth + ' | ' +
      divergenceMark(row) + ' |\n';
  }
  output += '\n### Family aggregation\n\n';
  output += '| family | positions | nodes | qnodes | NPS | wall time | move / score / depth divergences |\n';
  output += '|---|---:|---:|---:|---:|---:|---:|\n';
  for (const family of summary.families) {
    output += '| ' + family.name + ' | ' + family.positions + ' | ' +
      fmt(family.ratios.nodes) + 'x | ' +
      fmt(family.ratios.qnodes) + 'x | ' +
      fmt(family.ratios.nps) + 'x | ' +
      fmt(family.ratios.wallMs) + 'x | ' +
      family.divergence.move + ' / ' + family.divergence.score + ' / ' +
      family.divergence.depth + ' |\n';
  }
  if (summary.experimentMetricSums.candidate) {
    output += '\nCandidate `experiment_metric(0..' +
      (bench.EXPERIMENT_METRIC_SLOTS - 1) + ')` sums: `' +
      JSON.stringify(summary.experimentMetricSums.candidate) + '`.\n';
  }
  return output + '\n';
}

function timeMarkdown(title, screen) {
  const summary = screen.summary;
  let output = '## ' + title + '\n\n';
  output += 'Candidate deeper / tied / shallower: **' + summary.deeper + ' / ' +
    summary.tied + ' / ' + summary.shallower + '**. Mean completed depth: ' +
    fmt(summary.candidateMeanDepth, 2) + ' / ' +
    fmt(summary.referenceMeanDepth, 2) + '; paired NPS ' +
    fmt(summary.npsGeomean) + 'x.\n\n';
  output += '| position | deeper / tied / shallower | mean depth (cand / ref) | mean nodes (cand / ref) | mean qnodes (cand / ref) | NPS | move / score / depth divergence rounds |\n';
  output += '|---|---:|---:|---:|---:|---:|---:|\n';
  for (const row of screen.rows) {
    const value = row.summary;
    output += '| ' + row.name + ' | ' + value.deeper + ' / ' + value.tied +
      ' / ' + value.shallower + ' | ' +
      fmt(value.candidateMeanDepth, 2) + ' / ' +
      fmt(value.referenceMeanDepth, 2) + ' | ' +
      Math.round(value.candidateMeanNodes) + ' / ' +
      Math.round(value.referenceMeanNodes) + ' | ' +
      Math.round(value.candidateMeanQnodes) + ' / ' +
      Math.round(value.referenceMeanQnodes) + ' | ' +
      fmt(value.npsRatio) + 'x | ' + value.moveDivergences + ' / ' +
      value.scoreDivergences + ' / ' + value.depthDivergences + ' |\n';
  }
  return output + '\n';
}

function renderMarkdown(report) {
  let output = '# Rust/WASM deep-search experiment\n\n';
  output += '- Candidate: `' + report.config.candidateLabel + '`\n';
  output += '- Reference: `' + report.config.referenceLabel + '`\n';
  output += '- Protocol: fixed d' + report.config.depth + ', ' +
    report.config.fixedPairs + ' AB/BA pairs; ' + report.config.timeMs +
    ' ms, ' + report.config.timePairs + ' AB/BA pairs\n';
  output += '- Decision: **' + report.decision.code + '** — ' +
    report.decision.reasons.join('; ') + '\n';
  output += '- Scope: diagnostic search gate only; no tactics, strength, mobile thermal, or production approval\n\n';
  output += fixedMarkdown(
    'Canonical fixed-depth ' + report.fixedDepth.depth + ' sweep',
    report.fixedDepth);
  if (report.depth8) {
    output += fixedMarkdown(
      'Optional fixed-depth 8 bounded subset', report.depth8);
  }
  output += fixedMarkdown(
    'iPhone A14 debug-game witnesses at fixed depth ' +
      report.witnessFixed.depth,
    report.witnessFixed);
  output += timeMarkdown(
    report.config.timeMs + ' ms canonical time-to-depth', report.timeToDepth);
  output += timeMarkdown(
    report.config.timeMs + ' ms iPhone witness replay',
    report.witnessTimeToDepth);
  return output;
}

function renderCompact(report) {
  const fixed = report.fixedDepth.summary;
  const timed = report.timeToDepth.summary;
  const metrics = fixed.experimentMetricSums.candidate;
  const depthLabel = 'd' + report.fixedDepth.depth;
  let output = '| candidate | verdict | ' + depthLabel + ' nodes | ' +
    depthLabel + ' wall | ' + depthLabel + ' NPS | ' +
    'worst nodes | activity p/f | move/score/depth Δ | ' +
    '5s deeper/tied/shallower | metrics 0..15 |\n';
  output += '|---|---|---:|---:|---:|---:|---:|---:|---:|---|\n';
  output += '| ' + report.config.candidateLabel + ' | ' +
    report.decision.code + ' | ' + fmt(fixed.ratios.nodesGeomean) + 'x | ' +
    fmt(fixed.ratios.wallMsGeomean) + 'x | ' +
    fmt(fixed.ratios.npsGeomean) + 'x | ' +
    fmt(fixed.tails.worstPositionNodes.ratio) + 'x | ' +
    fixed.activityPositions + '/' + fixed.activityFamilies + ' | ' +
    fixed.divergences.move + '/' + fixed.divergences.score + '/' +
    fixed.divergences.depth + ' | ' + timed.deeper + '/' + timed.tied + '/' +
    timed.shallower + ' | ' + (metrics ? JSON.stringify(metrics) : '—') +
    ' |';
  return output;
}

async function main(argv) {
  const config = parseOptions(argv || process.argv.slice(2));
  const candidate = await bench.loadWasmEngine(
    config.candidatePath, config.candidateLabel);
  const reference = await bench.loadWasmEngine(
    config.referencePath, config.referenceLabel);
  const canonical = canonicalPositions();
  const fixedWarmup = runOrderedPair(
    candidate,
    reference,
    canonical[0].fen,
    { maxDepth: 3, nodeLimit: 0, timeMs: 0, quiesce: true },
    true
  );

  console.log('candidate: ' + config.candidateLabel + ' (' +
    config.candidatePath + ')');
  console.log('reference: ' + config.referenceLabel + ' (' +
    config.referencePath + ')');
  const report = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    node: process.version,
    config: {
      candidateLabel: config.candidateLabel,
      referenceLabel: config.referenceLabel,
      candidatePath: config.candidatePath,
      referencePath: config.referencePath,
      depth: config.depth,
      fixedPairs: config.fixedPairs,
      depth8Count: config.depth8Count,
      timeMs: config.timeMs,
      timePairs: config.timePairs,
      warmMs: config.warmMs,
      experimentMetricSlots: bench.EXPERIMENT_METRIC_SLOTS
    },
    modules: {
      candidate: {
        bytes: candidate.binaryBytes,
        brotliBytes: candidate.brotliBytes,
        instantiationMs: candidate.initMs,
        initialMemoryBytes: candidate.initialMemoryBytes
      },
      reference: {
        bytes: reference.binaryBytes,
        brotliBytes: reference.brotliBytes,
        instantiationMs: reference.initMs,
        initialMemoryBytes: reference.initialMemoryBytes
      }
    },
    fixedDepthWarmup: {
      depth: 3,
      position: canonical[0].name,
      order: fixedWarmup.order,
      candidate: measuredResult(fixedWarmup.candidate),
      reference: measuredResult(fixedWarmup.reference)
    }
  };

  report.fixedDepth = runFixedScreen(
    candidate, reference, canonical, config.depth, config.fixedPairs);
  report.depth8 = config.depth8Count
    ? runFixedScreen(
      candidate, reference, depth8Positions(config.depth8Count), 8,
      config.fixedPairs)
    : null;
  report.witnessFixed = runFixedScreen(
    candidate, reference, WITNESSES, config.depth, config.fixedPairs);
  report.timeToDepth = runTimeScreen(
    candidate, reference, canonical, config);
  report.witnessTimeToDepth = runTimeScreen(
    candidate, reference, WITNESSES, config);
  report.decision = finalDecision(
    report.fixedDepth.summary.gate, report.timeToDepth.summary);
  report.finishedAt = new Date().toISOString();
  report.modules.candidate.finalMemoryBytes = candidate.memoryBytes();
  report.modules.reference.finalMemoryBytes = reference.memoryBytes();

  const markdown = renderMarkdown(report);
  if (config.jsonPath) {
    fs.mkdirSync(path.dirname(config.jsonPath), { recursive: true });
    fs.writeFileSync(config.jsonPath, JSON.stringify(report, null, 2) + '\n');
  }
  if (config.markdownPath) {
    fs.mkdirSync(path.dirname(config.markdownPath), { recursive: true });
    fs.writeFileSync(config.markdownPath, markdown);
  }
  console.log('');
  console.log('decision: ' + report.decision.code + ' — ' +
    report.decision.reasons.join('; '));
  console.log('');
  console.log(renderCompact(report));
  if (!config.markdownPath) console.log('\n' + markdown);
  return report;
}

module.exports = Object.freeze({
  DEPTH8_FAMILY_INDEXES: DEPTH8_FAMILY_INDEXES,
  WITNESSES: WITNESSES,
  parseOptions: parseOptions,
  median: median,
  geometricMean: geometricMean,
  nearestRank: nearestRank,
  aggregateFixed: aggregateFixed,
  fixedDepthGate: fixedDepthGate,
  finalDecision: finalDecision,
  renderMarkdown: renderMarkdown,
  renderCompact: renderCompact,
  main: main
});

if (require.main === module) {
  main(process.argv.slice(2)).catch(function (error) {
    console.error('FAIL: ' + (error && error.stack || error));
    process.exitCode = 1;
  });
}
