/*
 * Hermetic E4-v1 certification-result validator and statistics helper.
 *
 * This module never runs games, selects openings, mutates a manifest, or enters
 * the shipped application. It accepts only a complete immutable result bundle
 * for an already-frozen certification manifest and fails closed on any gap.
 *
 *   node test/eval/e4-stats.js <frozen-manifest.json> <results.json>
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const E4 = require('./e4-protocol.js');

const ROOT = path.join(__dirname, '..', '..');
const CONTRACT_PATH = path.join(ROOT, 'eval', 'e4', 'stats-v1.json');
const IMPLEMENTATION_PATH = path.join(ROOT, 'test', 'eval', 'e4-stats.js');
const ELO_FACTOR = Math.log(10) / 400;
const UINT32_RANGE = 0x100000000;
const LEVEL_INDEX = new Map(E4.LEVELS.map(function (level, index) {
  return [level.id, index];
}));
const ADJACENT_BY_PAIR = new Map(E4.ADJACENT.map(function (pair) {
  return [pair.pair, pair];
}));
const CLAIM_ORDER = Object.freeze([
  'easy-band',
  'medium-band',
  'hard-band',
  'expert-band',
  'easy-medium',
  'medium-hard',
  'hard-expert',
  'expert-master'
]);
const BUNDLE_KEYS = Object.freeze([
  'analysisPhase',
  'complete',
  'contentSha256',
  'immutable',
  'manifestContentSha256',
  'manifestId',
  'protocolId',
  'removedResultIds',
  'rows',
  'rowsSha256',
  'schema',
  'statsContractSha256'
]);
const ROW_KEYS = Object.freeze([
  'anchor',
  'immutable',
  'levelOrPair',
  'manifestContentSha256',
  'manifestId',
  'openingClusterId',
  'openingId',
  'outcome',
  'resultId',
  'scheduleKind',
  'schema',
  'seed',
  'subject',
  'subjectColor',
  'termination'
]);
const OUTCOMES = Object.freeze(['win', 'draw', 'loss']);
const DRAW_TERMINATIONS = new Set([
  'stalemate',
  'repetition',
  'fifty-move',
  'insufficient-material',
  'draw-at-180-plies'
]);
const SUBJECT_FAILURES = new Set([
  'subject-illegal-move',
  'subject-crash',
  'subject-watchdog-timeout',
  'subject-lost-move'
]);
const OPPONENT_FAILURES = new Set([
  'opponent-illegal-move',
  'opponent-crash',
  'opponent-watchdog-timeout',
  'opponent-lost-move'
]);
let contractCache = null;

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function isObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fileSha256(filename) {
  return sha256(fs.readFileSync(filename));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function compareCodePoints(left, right) {
  const a = Array.from(left, character => character.codePointAt(0));
  const b = Array.from(right, character => character.codePointAt(0));
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return a.length === b.length ? 0 : (a.length < b.length ? -1 : 1);
}

function assertExactKeys(value, expected, label) {
  assert(isObject(value), label + ' must be an object');
  const actual = Object.keys(value).sort();
  const wanted = expected.slice().sort();
  assert(E4.stableJson(actual) === E4.stableJson(wanted),
    label + ' fields drifted: expected ' + wanted.join(', ') +
      ', got ' + actual.join(', '));
}

function validateStatsContract(contract) {
  assert(isObject(contract), 'statistics contract must be an object');
  assert(contract.schema === 'chessy.e4.statistics-contract.v1' &&
    contract.statsId === 'E4-stats-v1' &&
    contract.status === 'frozen' &&
    contract.protocolId === 'E4-v1',
  'statistics contract identity/status drifted');
  assert(contract.implementation.path === 'test/eval/e4-stats.js' &&
    contract.implementation.arithmetic === 'IEEE-754 binary64 under Node.js 22' &&
    Array.isArray(contract.implementation.externalDependencies) &&
    contract.implementation.externalDependencies.length === 0,
  'statistics implementation contract drifted');
  assert(contract.resultBundle.schema ===
    'chessy.e4.certification-results.v1' &&
    contract.resultBundle.rowSchema === 'chessy.e4.game-result.v1' &&
    contract.resultBundle.manifestStatusRequired === 'frozen' &&
    contract.resultBundle.manifestKindRequired === 'certification',
  'statistics result-bundle contract drifted');
  assert(contract.resultBundle.analysisPhases['master-first'].assignments === 800 &&
    contract.resultBundle.analysisPhases['master-first'].games === 1600 &&
    contract.resultBundle.analysisPhases['full-certification'].assignments === 4000 &&
    contract.resultBundle.analysisPhases['full-certification'].games === 8000,
  'statistics analysis-phase contract drifted');
  assert(contract.externalAnchorModel.family ===
    'Davidson extension of Bradley-Terry with logistic-Elo abilities' &&
    contract.externalAnchorModel.anchorRatingsFixed === true &&
    contract.externalAnchorModel.jointFit === true,
  'external-anchor model contract drifted');
  const fit = contract.externalAnchorModel.fit;
  assert(fit.criterion ===
    'unpenalized maximum log likelihood over every completed external-anchor game' &&
    fit.optimizer === 'analytic-Hessian damped Newton' &&
    fit.maximumIterations === 50 &&
    fit.gradientInfinityTolerance === 1e-9 &&
    fit.newtonDecrementSquaredTolerance === 1e-9 &&
    fit.singularPivotTolerance === 1e-14 &&
    fit.backtrackingFactor === 0.5 &&
    fit.minimumAbsoluteNllDecrease === 1e-12 &&
    fit.minimumLineSearchStep === Math.pow(2, -30),
  'external-anchor optimizer contract drifted');
  const bootstrap = contract.bootstrap;
  assert(bootstrap.kind === 'nonparametric stratified cluster bootstrap' &&
    bootstrap.replicates === 10000 &&
    bootstrap.rootSeed === 20260730 &&
    bootstrap.clusterUnit === 'opening assignment with both subject colors' &&
    bootstrap.rng.algorithm === 'xorshift32',
  'bootstrap contract drifted');
  const holm = contract.intervalsAndTests.holm;
  assert(holm.familywiseAlpha === 0.05 &&
    holm.method === 'Holm step-down' &&
    E4.stableJson(holm.claimsInTieBreakOrder) === E4.stableJson(CLAIM_ORDER),
  'Holm family contract drifted');
  return true;
}

function readStatsContract() {
  if (contractCache) return contractCache;
  const bytes = fs.readFileSync(CONTRACT_PATH);
  const contract = JSON.parse(bytes.toString('utf8'));
  const digest = sha256(bytes);
  assert(digest === E4.EXPECTED.statsSha256,
    'frozen E4-v1 statistics contract SHA-256 drifted');
  validateStatsContract(contract);
  contractCache = Object.freeze({
    contract,
    sha256: digest
  });
  return contractCache;
}

function bundleRowsSha256(rows) {
  return E4.canonicalSha256(rows);
}

function bundleContentSha256(bundle) {
  assert(isObject(bundle) &&
    Object.prototype.hasOwnProperty.call(bundle, 'contentSha256'),
  'result bundle contentSha256 field is missing');
  const payload = clone(bundle);
  payload.contentSha256 = null;
  return E4.canonicalSha256(payload);
}

function validateTermination(row, label) {
  const termination = row.termination;
  assert(typeof termination === 'string', label + '.termination must be a string');
  if (termination === 'checkmate') {
    assert(row.outcome === 'win' || row.outcome === 'loss',
      label + ' checkmate must be decisive');
    return;
  }
  if (DRAW_TERMINATIONS.has(termination)) {
    assert(row.outcome === 'draw',
      label + ' draw termination must have outcome=draw');
    return;
  }
  if (SUBJECT_FAILURES.has(termination)) {
    assert(row.outcome === 'loss',
      label + ' subject failure must have outcome=loss');
    return;
  }
  if (OPPONENT_FAILURES.has(termination)) {
    assert(row.outcome === 'win',
      label + ' opponent failure must have outcome=win');
    return;
  }
  fail(label + ' has an undeclared or unresolved termination: ' + termination);
}

function expectedGames(manifest, analysisPhase) {
  const expected = new Map();
  const clusterUse = new Set();
  const assignments = [];
  manifest.assignments.forEach(function (assignment, index) {
    const label = 'certification assignments[' + index + ']';
    assert(!clusterUse.has(assignment.openingClusterId),
      label + ' reuses an opening cluster across assignments');
    clusterUse.add(assignment.openingClusterId);
    const included = analysisPhase === 'full-certification' ||
      (analysisPhase === 'master-first' &&
        assignment.scheduleKind === 'cert' &&
        assignment.levelOrPair === 'master');
    if (!included) return;
    assignments.push({ assignment, index });
    const pair = assignment.scheduleKind === 'adjacent' ?
      ADJACENT_BY_PAIR.get(assignment.levelOrPair) : null;
    const subject = assignment.scheduleKind === 'cert' ?
      assignment.levelOrPair : pair && pair.stronger;
    assert(subject, label + ' has no declared statistical subject');
    const phase = assignment.scheduleKind === 'cert' ? 'cert' : 'adjacent';
    const seed = E4.deriveScheduleSeed(
      manifest.freeze.contentSha256, assignment.openingId);
    assignment.colors.forEach(function (subjectColor) {
      const resultId = E4.resultId({
        phase,
        levelOrPair: assignment.levelOrPair,
        anchor: assignment.anchor,
        openingId: assignment.openingId,
        seed,
        chessyColor: subjectColor
      });
      assert(!expected.has(resultId),
        label + ' generates a duplicate result ID: ' + resultId);
      expected.set(resultId, {
        assignmentIndex: index,
        scheduleKind: assignment.scheduleKind,
        levelOrPair: assignment.levelOrPair,
        anchor: assignment.anchor,
        openingClusterId: assignment.openingClusterId,
        openingId: assignment.openingId,
        seed,
        subject,
        subjectColor
      });
    });
  });
  return { expected, assignments };
}

function emptyCounter() {
  return {
    wins: 0,
    draws: 0,
    losses: 0,
    games: 0,
    scorePoints: 0,
    scoreRate: null
  };
}

function addOutcome(counter, outcome) {
  if (outcome === 'win') {
    counter.wins++;
    counter.scorePoints += 1;
  } else if (outcome === 'draw') {
    counter.draws++;
    counter.scorePoints += 0.5;
  } else {
    counter.losses++;
  }
  counter.games++;
}

function finishCounter(counter) {
  counter.scoreRate = counter.games ? counter.scorePoints / counter.games : null;
  return counter;
}

function validateCertificationResults(manifest, bundle) {
  E4.validateCertificationManifest(manifest);
  assert(manifest.status === 'frozen',
    'statistics require a frozen certification manifest');
  const loaded = readStatsContract();
  assertExactKeys(bundle, BUNDLE_KEYS, 'result bundle');
  assert(bundle.schema === loaded.contract.resultBundle.schema &&
    bundle.protocolId === 'E4-v1',
  'result bundle schema/protocol drifted');
  const phase = loaded.contract.resultBundle.analysisPhases[bundle.analysisPhase];
  assert(phase, 'result bundle analysisPhase must be master-first or full-certification');
  assert(bundle.statsContractSha256 === loaded.sha256,
    'result bundle statistics-contract SHA-256 mismatch');
  assert(bundle.manifestId === manifest.manifestId &&
    bundle.manifestContentSha256 === manifest.freeze.contentSha256,
  'result bundle manifest identity/hash mismatch');
  assert(bundle.immutable === true && bundle.complete === true,
    'result bundle must be immutable and complete');
  assert(Array.isArray(bundle.removedResultIds) &&
    bundle.removedResultIds.length === 0,
  'posthoc-removed results are forbidden');
  assert(Array.isArray(bundle.rows), 'result bundle rows must be an array');
  assert(bundle.rowsSha256 === bundleRowsSha256(bundle.rows),
    'result bundle row SHA-256 mismatch');
  assert(bundle.contentSha256 === bundleContentSha256(bundle),
    'result bundle content SHA-256 mismatch');

  const plan = expectedGames(manifest, bundle.analysisPhase);
  const expected = plan.expected;
  assert(plan.assignments.length === phase.assignments &&
    expected.size === phase.games,
  'frozen manifest does not match the declared ' +
    bundle.analysisPhase + ' result scope');
  assert(bundle.rows.length === expected.size,
    'missing or unexpected games: expected ' + expected.size +
      ', got ' + bundle.rows.length);
  const seen = new Set();
  const rowsByAssignment = new Map();
  let priorId = null;
  bundle.rows.forEach(function (row, index) {
    const label = 'result rows[' + index + ']';
    assertExactKeys(row, ROW_KEYS, label);
    assert(row.schema === loaded.contract.resultBundle.rowSchema,
      label + ' schema drifted');
    assert(row.immutable === true, label + ' must be immutable');
    assert(typeof row.resultId === 'string' && row.resultId.length > 0,
      label + '.resultId is missing');
    assert(priorId === null || compareCodePoints(priorId, row.resultId) < 0,
      label + ' is duplicate or not in canonical ascending resultId order');
    priorId = row.resultId;
    assert(!seen.has(row.resultId), 'duplicate result ID: ' + row.resultId);
    seen.add(row.resultId);
    const wanted = expected.get(row.resultId);
    assert(wanted, 'unexpected result ID: ' + row.resultId);
    assert(row.manifestId === manifest.manifestId &&
      row.manifestContentSha256 === manifest.freeze.contentSha256,
    label + ' manifest identity/hash mismatch');
    [
      'scheduleKind',
      'levelOrPair',
      'anchor',
      'openingClusterId',
      'openingId',
      'seed',
      'subject',
      'subjectColor'
    ].forEach(function (field) {
      assert(row[field] === wanted[field],
        label + '.' + field + ' does not match the frozen assignment');
    });
    assert(OUTCOMES.includes(row.outcome),
      label + '.outcome must be win, draw, or loss');
    validateTermination(row, label);
    if (!rowsByAssignment.has(wanted.assignmentIndex)) {
      rowsByAssignment.set(wanted.assignmentIndex, []);
    }
    rowsByAssignment.get(wanted.assignmentIndex).push(row);
  });
  expected.forEach(function (_, resultId) {
    assert(seen.has(resultId), 'missing scheduled result: ' + resultId);
  });

  const total = emptyCounter();
  const bySchedule = new Map();
  const openingClusters = plan.assignments.map(function (item) {
    const assignment = item.assignment;
    const rows = rowsByAssignment.get(item.index) || [];
    assert(rows.length === 2,
      'assignment ' + item.index + ' does not have exactly two completed games');
    assert(new Set(rows.map(row => row.subjectColor)).size === 2,
      'assignment ' + item.index + ' does not contain both subject colors');
    const counter = emptyCounter();
    rows.forEach(function (row) {
      addOutcome(counter, row.outcome);
      addOutcome(total, row.outcome);
    });
    const key = assignment.scheduleKind + '/' + assignment.levelOrPair + '/' +
      assignment.anchor;
    if (!bySchedule.has(key)) bySchedule.set(key, emptyCounter());
    rows.forEach(row => addOutcome(bySchedule.get(key), row.outcome));
    finishCounter(counter);
    return {
      scheduleKind: assignment.scheduleKind,
      levelOrPair: assignment.levelOrPair,
      anchor: assignment.anchor,
      openingClusterId: assignment.openingClusterId,
      openingId: assignment.openingId,
      wins: counter.wins,
      draws: counter.draws,
      losses: counter.losses,
      games: counter.games,
      scorePoints: counter.scorePoints,
      scoreRate: counter.scoreRate,
      rows: rows.slice().sort((a, b) =>
        a.subjectColor.localeCompare(b.subjectColor))
    };
  });
  finishCounter(total);
  const schedules = Array.from(bySchedule, function (entry) {
    const counter = finishCounter(entry[1]);
    return Object.assign({ schedule: entry[0] }, counter);
  }).sort((a, b) => a.schedule.localeCompare(b.schedule));
  return {
    contract: loaded.contract,
    statsContractSha256: loaded.sha256,
    analysisPhase: bundle.analysisPhase,
    bundle,
    rows: bundle.rows,
    openingClusters,
    total,
    schedules
  };
}

function davidsonProbabilities(ratingElo, anchorElo, colorEffectElo, logNu,
  subjectColor) {
  assert(subjectColor === 'white' || subjectColor === 'black',
    'subjectColor must be white or black');
  const sign = subjectColor === 'white' ? 1 : -1;
  const eta = ELO_FACTOR *
    (ratingElo - anchorElo + sign * colorEffectElo);
  const logits = [eta, logNu + eta / 2, 0];
  const maximum = Math.max.apply(null, logits);
  const values = logits.map(value => Math.exp(value - maximum));
  const denominator = values[0] + values[1] + values[2];
  return {
    win: values[0] / denominator,
    draw: values[1] / denominator,
    loss: values[2] / denominator
  };
}

function externalDesign(activeLevels) {
  const levels = activeLevels || E4.LEVELS;
  const cells = [];
  const index = new Map();
  levels.forEach(function (level, levelIndex) {
    level.anchors.slice().sort((a, b) => a - b).forEach(function (anchor) {
      ['white', 'black'].forEach(function (color) {
        const cell = {
          level: level.id,
          levelIndex,
          anchor,
          color,
          colorSign: color === 'white' ? 1 : -1
        };
        index.set(level.id + '/' + anchor + '/' + color, cells.length);
        cells.push(cell);
      });
    });
  });
  return {
    cells,
    index,
    levels,
    colorIndex: levels.length,
    drawIndex: levels.length + 1,
    parameterCount: levels.length + 2
  };
}

function cellProbabilities(theta, cell, design) {
  const eta = theta[cell.levelIndex] - ELO_FACTOR * cell.anchor +
    cell.colorSign * theta[design.colorIndex];
  const logits = [eta, theta[design.drawIndex] + eta / 2, 0];
  const maximum = Math.max(logits[0], logits[1], logits[2]);
  const ew = Math.exp(logits[0] - maximum);
  const ed = Math.exp(logits[1] - maximum);
  const el = Math.exp(-maximum);
  const sum = ew + ed + el;
  return {
    probabilities: [ew / sum, ed / sum, el / sum],
    logProbabilities: [
      logits[0] - maximum - Math.log(sum),
      logits[1] - maximum - Math.log(sum),
      -maximum - Math.log(sum)
    ]
  };
}

function likelihoodState(theta, counts, design, withDerivatives) {
  let negativeLogLikelihood = 0;
  const gradient = withDerivatives ?
    new Float64Array(design.parameterCount) : null;
  const hessian = withDerivatives ?
    Array.from({ length: design.parameterCount },
      () => new Float64Array(design.parameterCount)) : null;
  design.cells.forEach(function (cell, cellIndex) {
    const offset = cellIndex * 3;
    const wins = counts[offset];
    const draws = counts[offset + 1];
    const losses = counts[offset + 2];
    const total = wins + draws + losses;
    if (!total) return;
    const calculated = cellProbabilities(theta, cell, design);
    const p = calculated.probabilities;
    const logp = calculated.logProbabilities;
    negativeLogLikelihood -= wins * logp[0] + draws * logp[1] +
      losses * logp[2];
    if (!withDerivatives) return;

    const sign = cell.colorSign;
    const mean0 = p[0] + 0.5 * p[1];
    const mean1 = sign * mean0;
    const mean2 = p[1];
    const indices = [
      cell.levelIndex,
      design.colorIndex,
      design.drawIndex
    ];
    const observed0 = wins + 0.5 * draws;
    gradient[indices[0]] += total * mean0 - observed0;
    gradient[indices[1]] += sign * (total * mean0 - observed0);
    gradient[indices[2]] += total * mean2 - draws;

    const expected00 = p[0] + 0.25 * p[1];
    const expected = [
      [expected00, sign * expected00, 0.5 * p[1]],
      [sign * expected00, expected00, 0.5 * sign * p[1]],
      [0.5 * p[1], 0.5 * sign * p[1], p[1]]
    ];
    const means = [mean0, mean1, mean2];
    for (let row = 0; row < 3; row++) {
      for (let column = 0; column < 3; column++) {
        hessian[indices[row]][indices[column]] += total *
          (expected[row][column] - means[row] * means[column]);
      }
    }
  });
  return { negativeLogLikelihood, gradient, hessian };
}

function solveLinear(matrix, right, pivotTolerance) {
  const size = right.length;
  const a = matrix.map(function (row, index) {
    return Array.from(row).concat([right[index]]);
  });
  for (let column = 0; column < size; column++) {
    let pivot = column;
    for (let row = column + 1; row < size; row++) {
      if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row;
    }
    assert(Number.isFinite(a[pivot][column]) &&
      Math.abs(a[pivot][column]) > pivotTolerance,
    'external-anchor Hessian is singular');
    if (pivot !== column) {
      const temporary = a[column];
      a[column] = a[pivot];
      a[pivot] = temporary;
    }
    const divisor = a[column][column];
    for (let item = column; item <= size; item++) a[column][item] /= divisor;
    for (let row = 0; row < size; row++) {
      if (row === column) continue;
      const factor = a[row][column];
      if (!factor) continue;
      for (let item = column; item <= size; item++) {
        a[row][item] -= factor * a[column][item];
      }
    }
  }
  return a.map(row => row[size]);
}

function fitExternalCounts(counts, design) {
  const loaded = readStatsContract();
  const fit = loaded.contract.externalAnchorModel.fit;
  let theta = new Float64Array(design.parameterCount);
  design.levels.forEach(function (level, index) {
    theta[index] = ELO_FACTOR * level.nominalElo;
  });
  theta[design.colorIndex] = ELO_FACTOR * fit.initialColorEffectElo;
  theta[design.drawIndex] = Math.log(fit.initialNu);
  let finalState = null;
  for (let iteration = 0; iteration <= fit.maximumIterations; iteration++) {
    const state = likelihoodState(theta, counts, design, true);
    assert(Number.isFinite(state.negativeLogLikelihood),
      'external-anchor likelihood became non-finite');
    const gradientInfinity = Math.max.apply(null,
      Array.from(state.gradient, value => Math.abs(value)));
    if (gradientInfinity <= fit.gradientInfinityTolerance) {
      finalState = {
        state,
        iterations: iteration,
        gradientInfinity
      };
      break;
    }
    assert(iteration < fit.maximumIterations,
      'external-anchor fit did not converge in ' +
        fit.maximumIterations + ' iterations');
    const step = solveLinear(
      state.hessian, state.gradient, fit.singularPivotTolerance);
    const decrementSquared = step.reduce(function (sum, value, index) {
      return sum + value * state.gradient[index];
    }, 0);
    assert(Number.isFinite(decrementSquared) && decrementSquared >= 0,
      'external-anchor Newton decrement became invalid');
    if (decrementSquared <= fit.newtonDecrementSquaredTolerance) {
      finalState = {
        state,
        iterations: iteration,
        gradientInfinity,
        decrementSquared
      };
      break;
    }
    let scale = 1;
    let accepted = null;
    while (scale >= fit.minimumLineSearchStep) {
      const candidate = Float64Array.from(theta, function (value, index) {
        return value - scale * step[index];
      });
      const candidateState = likelihoodState(candidate, counts, design, false);
      if (Number.isFinite(candidateState.negativeLogLikelihood) &&
          candidateState.negativeLogLikelihood <
            state.negativeLogLikelihood -
              fit.minimumAbsoluteNllDecrease) {
        accepted = candidate;
        break;
      }
      scale *= fit.backtrackingFactor;
    }
    assert(accepted, 'external-anchor Newton line search failed at iteration ' +
      iteration + ' with gradient infinity norm ' + gradientInfinity);
    theta = accepted;
  }
  assert(finalState, 'external-anchor fit did not produce a converged state');
  const ratings = {};
  design.levels.forEach(function (level, index) {
    ratings[level.id] = theta[index] / ELO_FACTOR;
  });
  const games = Array.from(counts).reduce((sum, value) => sum + value, 0);
  return {
    ratings,
    colorEffectElo: theta[design.colorIndex] / ELO_FACTOR,
    drawParameterNu: Math.exp(theta[design.drawIndex]),
    logNu: theta[design.drawIndex],
    negativeLogLikelihood: finalState.state.negativeLogLikelihood,
    gradientInfinityNorm: finalState.gradientInfinity,
    iterations: finalState.iterations,
    games,
    converged: true
  };
}

function buildExternalData(openingClusters, activeLevels) {
  const design = externalDesign(activeLevels);
  const strataMap = new Map();
  design.levels.forEach(function (level) {
    level.anchors.slice().sort((a, b) => a - b).forEach(function (anchor) {
      strataMap.set(level.id + '/' + anchor, []);
    });
  });
  openingClusters.forEach(function (cluster) {
    if (cluster.scheduleKind !== 'cert') return;
    if (!design.levels.some(level => level.id === cluster.levelOrPair)) return;
    const stratumKey = cluster.levelOrPair + '/' + cluster.anchor;
    const stratum = strataMap.get(stratumKey);
    assert(stratum, 'external result uses an undeclared level/anchor stratum');
    const contributions = cluster.rows.map(function (row) {
      const cell = design.index.get(
        row.levelOrPair + '/' + row.anchor + '/' + row.subjectColor);
      assert(Number.isInteger(cell), 'external result has no model cell');
      return cell * 3 + OUTCOMES.indexOf(row.outcome);
    });
    assert(contributions.length === 2,
      'external opening cluster must contribute its paired colors');
    stratum.push(contributions);
  });
  const strata = Array.from(strataMap, function (entry) {
    assert(entry[1].length > 0, 'external stratum is empty: ' + entry[0]);
    return { key: entry[0], clusters: entry[1] };
  });
  const counts = new Float64Array(design.cells.length * 3);
  strata.forEach(stratum => stratum.clusters.forEach(cluster =>
    cluster.forEach(index => counts[index]++)));
  return { design, strata, counts };
}

function deriveStreamSeed(rootSeed, streamId) {
  assert(Number.isSafeInteger(rootSeed) && rootSeed >= 0,
    'bootstrap root seed must be a nonnegative safe integer');
  assert(typeof streamId === 'string' && streamId.length > 0,
    'bootstrap stream ID must be a nonempty string');
  const digest = crypto.createHash('sha256').update(
    'E4-stats-v1\0' + String(rootSeed) + '\0' + streamId, 'utf8').digest();
  const value = digest.readUInt32BE(0);
  return value === 0 ? 0x6d2b79f5 : value;
}

class XorShift32 {
  constructor(seed) {
    assert(Number.isInteger(seed) && seed > 0 && seed <= 0xffffffff,
      'xorshift32 seed must be a nonzero uint32');
    this.state = seed >>> 0;
  }

  nextUint32() {
    let value = this.state;
    value ^= (value << 13) >>> 0;
    value ^= value >>> 17;
    value ^= (value << 5) >>> 0;
    this.state = value >>> 0;
    return this.state;
  }

  index(size) {
    assert(Number.isSafeInteger(size) && size > 0,
      'bootstrap stratum size must be positive');
    return Math.floor(this.nextUint32() * size / UINT32_RANGE);
  }
}

function bootstrapExternal(openingClusters, activeLevels, requestedStreamId) {
  const loaded = readStatsContract();
  const bootstrap = loaded.contract.bootstrap;
  const data = buildExternalData(openingClusters, activeLevels);
  const point = fitExternalCounts(data.counts, data.design);
  const samples = data.design.levels.map(() =>
    new Float64Array(bootstrap.replicates));
  const streamId = requestedStreamId ||
    bootstrap.streamIds.externalRatings;
  const streamSeed = deriveStreamSeed(
    bootstrap.rootSeed, streamId);
  const rng = new XorShift32(streamSeed);
  for (let replicate = 0; replicate < bootstrap.replicates; replicate++) {
    const counts = new Float64Array(data.counts.length);
    data.strata.forEach(function (stratum) {
      const size = stratum.clusters.length;
      for (let draw = 0; draw < size; draw++) {
        const cluster = stratum.clusters[rng.index(size)];
        counts[cluster[0]]++;
        counts[cluster[1]]++;
      }
    });
    const fitted = fitExternalCounts(counts, data.design);
    data.design.levels.forEach(function (level, index) {
      samples[index][replicate] = fitted.ratings[level.id];
    });
  }
  return {
    point,
    samples,
    replicates: bootstrap.replicates,
    rootSeed: bootstrap.rootSeed,
    streamSeed,
    streamId
  };
}

function quantileType7(values, probability) {
  assert(values && Number.isInteger(values.length) && values.length > 0,
    'quantile needs at least one value');
  assert(Number.isFinite(probability) && probability >= 0 && probability <= 1,
    'quantile probability must be in [0,1]');
  const sorted = Float64Array.from(values);
  sorted.sort();
  const h = (sorted.length - 1) * probability;
  const lower = Math.floor(h);
  const upper = Math.ceil(h);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (h - lower) * (sorted[upper] - sorted[lower]);
}

function basicLower(point, samples) {
  return 2 * point - quantileType7(samples, 0.95);
}

function basicTwoSided90(point, samples) {
  return {
    lower: 2 * point - quantileType7(samples, 0.95),
    upper: 2 * point - quantileType7(samples, 0.05)
  };
}

function rightTailedBootstrapP(samples, point, nullValue) {
  let extreme = 0;
  const threshold = point - nullValue;
  for (const value of samples) {
    if (value - point >= threshold) extreme++;
  }
  return (1 + extreme) / (samples.length + 1);
}

function leftTailedBootstrapP(samples, point, nullValue) {
  let extreme = 0;
  const threshold = point - nullValue;
  for (const value of samples) {
    if (value - point <= threshold) extreme++;
  }
  return (1 + extreme) / (samples.length + 1);
}

function bootstrapAdjacentPair(openingClusters, pairId) {
  const loaded = readStatsContract();
  const bootstrap = loaded.contract.bootstrap;
  const values = openingClusters.filter(cluster =>
    cluster.scheduleKind === 'adjacent' &&
      cluster.levelOrPair === pairId).map(cluster => cluster.scoreRate);
  assert(values.length > 0, 'adjacent pair has no opening clusters: ' + pairId);
  assert(values.every(value => Number.isFinite(value) && value >= 0 && value <= 1),
    'adjacent pair has an invalid opening-cluster score: ' + pairId);
  const point = values.reduce((sum, value) => sum + value, 0) / values.length;
  const samples = new Float64Array(bootstrap.replicates);
  const streamId = bootstrap.streamIds.adjacentPrefix + pairId;
  const streamSeed = deriveStreamSeed(bootstrap.rootSeed, streamId);
  const rng = new XorShift32(streamSeed);
  for (let replicate = 0; replicate < bootstrap.replicates; replicate++) {
    let total = 0;
    for (let draw = 0; draw < values.length; draw++) {
      total += values[rng.index(values.length)];
    }
    samples[replicate] = total / values.length;
  }
  return {
    pair: pairId,
    openingClusters: values.length,
    games: values.length * 2,
    scoreRate: point,
    lowerBound95: basicLower(point, samples),
    rawPValue: rightTailedBootstrapP(samples, point, 0.5),
    samples,
    replicates: bootstrap.replicates,
    rootSeed: bootstrap.rootSeed,
    streamId,
    streamSeed
  };
}

function holmStepDown(claims, alpha) {
  assert(Array.isArray(claims) && claims.length === CLAIM_ORDER.length,
    'Holm requires the complete frozen eight-claim family');
  assert(Number.isFinite(alpha) && alpha > 0 && alpha < 1,
    'Holm alpha must be in (0,1)');
  const orderIndex = new Map(CLAIM_ORDER.map((id, index) => [id, index]));
  const seen = new Set();
  claims.forEach(function (claim) {
    assert(orderIndex.has(claim.id), 'undeclared Holm claim: ' + claim.id);
    assert(!seen.has(claim.id), 'duplicate Holm claim: ' + claim.id);
    seen.add(claim.id);
    assert(Number.isFinite(claim.rawPValue) &&
      claim.rawPValue >= 0 && claim.rawPValue <= 1,
    'invalid raw p-value for ' + claim.id);
  });
  assert(seen.size === CLAIM_ORDER.length &&
    CLAIM_ORDER.every(id => seen.has(id)),
  'Holm claim family is incomplete');
  const ordered = claims.slice().sort(function (left, right) {
    return left.rawPValue - right.rawPValue ||
      orderIndex.get(left.id) - orderIndex.get(right.id);
  });
  let stopped = false;
  let runningAdjusted = 0;
  ordered.forEach(function (claim, index) {
    const remaining = ordered.length - index;
    claim.rank = index + 1;
    claim.threshold = alpha / remaining;
    claim.rejected = !stopped && claim.rawPValue <= claim.threshold;
    if (!claim.rejected) stopped = true;
    runningAdjusted = Math.max(
      runningAdjusted, Math.min(1, remaining * claim.rawPValue));
    claim.adjustedPValue = runningAdjusted;
  });
  const byId = new Map(ordered.map(claim => [claim.id, claim]));
  return claims.map(function (claim) {
    const result = byId.get(claim.id);
    return {
      id: result.id,
      rawPValue: result.rawPValue,
      adjustedPValue: result.adjustedPValue,
      rank: result.rank,
      threshold: result.threshold,
      rejected: result.rejected
    };
  });
}

function publicOpeningSummary(cluster) {
  const result = Object.assign({}, cluster);
  delete result.rows;
  return result;
}

function commonReportIdentity(validated, manifest, bundle) {
  return {
    statsId: validated.contract.statsId,
    protocolId: 'E4-v1',
    analysisPhase: validated.analysisPhase,
    statsContractSha256: validated.statsContractSha256,
    estimatorSourceSha256: fileSha256(IMPLEMENTATION_PATH),
    manifestId: manifest.manifestId,
    manifestContentSha256: manifest.freeze.contentSha256,
    resultBundleContentSha256: bundle.contentSha256,
    inputs: {
      assignments: validated.openingClusters.length,
      games: validated.rows.length,
      openingClusters: validated.openingClusters.length
    },
    aggregate: {
      total: validated.total,
      schedules: validated.schedules,
      openingClusters: validated.openingClusters.map(publicOpeningSummary)
    }
  };
}

function analyzeMasterFirst(manifest, bundle) {
  const validated = validateCertificationResults(manifest, bundle);
  assert(validated.analysisPhase === 'master-first',
    'Master-first analysis requires analysisPhase=master-first');
  const masterLevel = E4.LEVELS.find(level => level.id === 'master');
  const external = bootstrapExternal(
    validated.openingClusters,
    [masterLevel],
    validated.contract.bootstrap.streamIds.masterFirstRating);
  const point = external.point.ratings.master;
  const lower = basicLower(point, external.samples[0]);
  const master = {
    pointEstimateElo: point,
    oneSided95LowerBoundElo: lower,
    requiredLowerBoundElo: 2300,
    pass: lower >= 2300
  };
  const report = Object.assign({
    schema: 'chessy.e4.master-first-analysis.v1'
  }, commonReportIdentity(validated, manifest, bundle), {
    externalAnchorModel: external.point,
    bootstrap: {
      kind: validated.contract.bootstrap.kind,
      replicates: external.replicates,
      rootSeed: external.rootSeed,
      streamId: external.streamId,
      streamSeed: external.streamSeed
    },
    master,
    gates: {
      master: master.pass
    },
    remainingCertificationAnalysisRequired: true,
    runtimeFilesChanged: false,
    analysisContentSha256: null
  });
  report.analysisContentSha256 = E4.canonicalSha256(report);
  return report;
}

function analyzeCertification(manifest, bundle) {
  const validated = validateCertificationResults(manifest, bundle);
  assert(validated.analysisPhase === 'full-certification',
    'Full certification analysis requires analysisPhase=full-certification');
  const external = bootstrapExternal(validated.openingClusters);
  const bandClaims = [];
  const bands = E4.LEVELS.slice(0, 4).map(function (level, index) {
    const point = external.point.ratings[level.id];
    const samples = external.samples[index];
    const interval = basicTwoSided90(point, samples);
    const lowerEdge = level.nominalElo - 100;
    const upperEdge = level.nominalElo + 100;
    const rawPValue = Math.max(
      rightTailedBootstrapP(samples, point, lowerEdge),
      leftTailedBootstrapP(samples, point, upperEdge));
    const row = {
      id: level.id + '-band',
      level: level.id,
      pointEstimateElo: point,
      lowerBound90: interval.lower,
      upperBound90: interval.upper,
      requiredLowerElo: lowerEdge,
      requiredUpperElo: upperEdge,
      intervalInsideBand: interval.lower >= lowerEdge &&
        interval.upper <= upperEdge,
      rawPValue
    };
    bandClaims.push({ id: row.id, rawPValue });
    return row;
  });
  const masterIndex = LEVEL_INDEX.get('master');
  const masterPoint = external.point.ratings.master;
  const masterLower = basicLower(masterPoint, external.samples[masterIndex]);
  const master = {
    pointEstimateElo: masterPoint,
    oneSided95LowerBoundElo: masterLower,
    requiredLowerBoundElo: 2300,
    pass: masterLower >= 2300
  };

  const adjacentInternal = E4.ADJACENT.map(pair =>
    bootstrapAdjacentPair(validated.openingClusters, pair.pair));
  const adjacentClaims = adjacentInternal.map(row => ({
    id: row.pair,
    rawPValue: row.rawPValue
  }));
  const holmInput = bandClaims.concat(adjacentClaims);
  assert(E4.stableJson(holmInput.map(claim => claim.id)) ===
    E4.stableJson(CLAIM_ORDER),
  'Holm claim construction drifted');
  const holm = holmStepDown(
    holmInput, validated.contract.intervalsAndTests.holm.familywiseAlpha);
  const holmById = new Map(holm.map(row => [row.id, row]));
  bands.forEach(function (row) {
    const adjusted = holmById.get(row.id);
    row.holmRejected = adjusted.rejected;
    row.adjustedPValue = adjusted.adjustedPValue;
    row.pass = row.intervalInsideBand && row.holmRejected;
  });
  const adjacent = adjacentInternal.map(function (row) {
    const adjusted = holmById.get(row.pair);
    return {
      pair: row.pair,
      openingClusters: row.openingClusters,
      games: row.games,
      scoreRate: row.scoreRate,
      oneSided95LowerBound: row.lowerBound95,
      rawPValue: row.rawPValue,
      adjustedPValue: adjusted.adjustedPValue,
      holmRejected: adjusted.rejected,
      pass: row.lowerBound95 > 0.5 && adjusted.rejected,
      bootstrapStreamId: row.streamId,
      bootstrapStreamSeed: row.streamSeed
    };
  });

  const report = {
    schema: 'chessy.e4.certification-analysis.v1',
    ...commonReportIdentity(validated, manifest, bundle),
    externalAnchorModel: external.point,
    bootstrap: {
      kind: validated.contract.bootstrap.kind,
      replicates: external.replicates,
      rootSeed: external.rootSeed,
      externalStreamId: external.streamId,
      externalStreamSeed: external.streamSeed
    },
    bands,
    master,
    adjacent,
    holm: {
      familywiseAlpha:
        validated.contract.intervalsAndTests.holm.familywiseAlpha,
      claims: holm
    },
    gates: {
      master: master.pass,
      lowerLevelBands: bands.every(row => row.pass),
      adjacentLevels: adjacent.every(row => row.pass)
    },
    runtimeFilesChanged: false,
    analysisContentSha256: null
  };
  report.analysisContentSha256 = E4.canonicalSha256(report);
  return report;
}

function main() {
  if (process.argv.length !== 4) {
    console.error(
      'usage: node test/eval/e4-stats.js <frozen-manifest.json> <results.json>');
    process.exitCode = 2;
    return;
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const bundle = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
    const report = bundle.analysisPhase === 'master-first' ?
      analyzeMasterFirst(manifest, bundle) :
      analyzeCertification(manifest, bundle);
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } catch (error) {
    console.error('E4 statistics failed: ' +
      String(error && error.stack || error));
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  CONTRACT_PATH,
  IMPLEMENTATION_PATH,
  CLAIM_ORDER,
  OUTCOMES,
  compareCodePoints,
  readStatsContract,
  validateStatsContract,
  bundleRowsSha256,
  bundleContentSha256,
  validateCertificationResults,
  davidsonProbabilities,
  fitExternalCounts,
  deriveStreamSeed,
  XorShift32,
  quantileType7,
  basicLower,
  basicTwoSided90,
  rightTailedBootstrapP,
  leftTailedBootstrapP,
  bootstrapAdjacentPair,
  holmStepDown,
  analyzeMasterFirst,
  analyzeCertification
});

if (require.main === module) main();
