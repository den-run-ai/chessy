#!/usr/bin/env node
/*
 * Deterministic research-only position stream for a bounded HCE mechanism
 * pilot.  This deliberately does not implement, bypass, or impersonate the
 * authenticated production-corpus path in pack-hce.py.
 *
 * Positions are legal random continuations of Chessy's checked-in MIT/CC0
 * evaluation corpus.  Rows are grouped by the same structural family key as
 * the production training contract before they are assigned to a split.
 * Labels are intentionally absent: run-hce-synthetic-pilot.py adds a planted
 * synthetic teacher and marks every result as ineligible for a quality claim.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

require('../../assets/engine.js');
const Corpus = require('../../test/training/corpus');
const H = require('../../test/training/hce-r3-features');
const Linear = require('../../test/training/hce-r3-linear');
const Baseline = require('../../test/training/hce-r3-baseline');

const ROOT = path.join(__dirname, '..', '..');
const CORPUS_PATH = path.join(ROOT, 'eval', 'corpus', 'eval-v1.ndjson');
const HELDOUT_PATH = path.join(ROOT, 'eval', 'training', 'heldout-v1.json');
const SCHEMA = 'chessy.hce-synthetic-pilot-row.v1';
const SPLITS = Object.freeze(['train', 'validation', 'test']);
const PHASES = Object.freeze(['opening', 'middlegame', 'endgame']);
const DEFAULT_ROWS = 12000;
const DEFAULT_SEED = 1370914;
const FAMILY_CAP = 4;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function mulberry32(seed) {
  let value = seed >>> 0;
  return function () {
    value = (value + 0x6D2B79F5) >>> 0;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function allocate(total, labels) {
  const base = Math.floor(total / labels.length);
  let remainder = total - base * labels.length;
  return Object.fromEntries(labels.map(function (label) {
    const count = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder--;
    return [label, count];
  }));
}

function rowQuotas(rows) {
  if (!Number.isSafeInteger(rows) || rows < 90) {
    throw new Error('--rows must be an integer of at least 90');
  }
  const train = Math.floor(rows * 0.70);
  const validation = Math.floor(rows * 0.15);
  const splitCounts = {
    train,
    validation,
    test: rows - train - validation
  };
  return Object.fromEntries(SPLITS.map(function (split) {
    return [split, allocate(splitCounts[split], PHASES)];
  }));
}

function splitForFamily(family) {
  if (!/^[0-9a-f]{64}$/.test(family)) {
    throw new Error('position-family ID must be SHA-256 hex');
  }
  const cell = parseInt(family.slice(0, 12), 16) % 20;
  if (cell < 14) return 'train';
  if (cell < 17) return 'validation';
  return 'test';
}

function parseArgs(argv) {
  const args = { rows: DEFAULT_ROWS, seed: DEFAULT_SEED, metadata: false };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (flag === '--metadata' && index === argv.length - 1) {
      args.metadata = true;
      break;
    }
    if (index + 1 >= argv.length) throw new Error('missing value for ' + flag);
    const value = argv[index + 1];
    if (flag === '--rows') args.rows = Number(value);
    else if (flag === '--seed') args.seed = Number(value);
    else throw new Error('unknown argument: ' + flag);
  }
  if (!Number.isSafeInteger(args.seed) || args.seed < 0 || args.seed > 0xffffffff) {
    throw new Error('--seed must be an integer in [0, 2^32 - 1]');
  }
  if (!args.metadata) rowQuotas(args.rows);
  return args;
}

function loadSeeds() {
  const rows = fs.readFileSync(CORPUS_PATH, 'utf8').trim().split('\n')
    .map(function (line) { return JSON.parse(line); });
  const pools = Object.fromEntries(PHASES.map(function (phase) {
    return [phase, []];
  }));
  for (const record of rows) {
    const fen = record.fen || record.source_fen;
    if (typeof fen !== 'string') continue;
    try {
      const state = Chess.newGameState(fen);
      if (Chess.gameStatus(state).over) continue;
      const fen4 = Corpus.parseFen4(Chess.toFen(state)).fen4;
      const phase = Corpus.phaseBucket(fen4);
      pools[phase].push({
        id: record.id,
        fen: Chess.toFen(state),
        license: record.license,
        sourceSha256: record.source_sha
      });
    } catch (_) {
      // A correctness fixture may intentionally encode a terminal or otherwise
      // unsuitable state.  It is not silently repaired for this pilot.
    }
  }
  for (const phase of PHASES) {
    if (!pools[phase].length) throw new Error('no usable ' + phase + ' seeds');
    pools[phase].sort(function (left, right) {
      return String(left.id).localeCompare(String(right.id));
    });
  }
  return pools;
}

function chooseMove(moves, random) {
  const forcing = moves.filter(function (move) {
    return move.captured || move.promotion || move.ep;
  });
  const source = forcing.length && random() < 0.38 ? forcing : moves;
  return source[Math.floor(random() * source.length)];
}

function continuation(seed, phase, random) {
  let state = Chess.newGameState(seed.fen);
  const maxPlies = phase === 'opening' ? 12 : phase === 'middlegame' ? 22 : 30;
  const plies = 1 + Math.floor(random() * maxPlies);
  for (let ply = 0; ply < plies; ply++) {
    const moves = Chess.legalMoves(state);
    if (!moves.length) break;
    state = Chess.playMove(state, chooseMove(moves, random));
    if (Chess.gameStatus(state).over) break;
  }
  if (Chess.gameStatus(state).over) return null;
  return state;
}

function quotaTotal(quotas) {
  let total = 0;
  for (const split of SPLITS) {
    for (const phase of PHASES) total += quotas[split][phase];
  }
  return total;
}

function currentTotal(counts) {
  let total = 0;
  for (const split of SPLITS) {
    for (const phase of PHASES) total += counts[split][phase];
  }
  return total;
}

function nextNeededPhase(quotas, counts) {
  let best = null;
  for (const phase of PHASES) {
    let needed = 0;
    for (const split of SPLITS) {
      needed += quotas[split][phase] - counts[split][phase];
    }
    if (needed > 0 && (!best || needed > best.needed)) best = { phase, needed };
  }
  return best && best.phase;
}

function makeRow(state, source, split, phase, cluster, family) {
  const fen = Corpus.parseFen4(Chess.toFen(state)).fen4;
  const compiled = Linear.compile(fen);
  const id = sha256('chessy-hce-synthetic-pilot-v1\n' + fen);
  return {
    schema: SCHEMA,
    id,
    fen,
    cluster,
    positionFamily: family,
    split,
    phase,
    fixedCp: compiled.fixedCp,
    indices: compiled.sparse.map(function (entry) { return entry[0]; }),
    data: compiled.sparse.map(function (entry) { return entry[1]; }),
    sourceSeed: {
      id: source.id,
      license: source.license,
      sourceSha256: source.sourceSha256
    }
  };
}

function generate(options) {
  const rows = options && options.rows == null ? DEFAULT_ROWS : options.rows;
  const seedValue = options && options.seed == null ? DEFAULT_SEED : options.seed;
  const quotas = rowQuotas(rows);
  if (!Number.isSafeInteger(seedValue) || seedValue < 0 || seedValue > 0xffffffff) {
    throw new Error('seed must be an integer in [0, 2^32 - 1]');
  }
  const random = mulberry32(seedValue);
  const pools = loadSeeds();
  const heldout = JSON.parse(fs.readFileSync(HELDOUT_PATH, 'utf8'));
  const incidentCluster = heldout.symmetryPolicy.clusterSha256;
  const incidentFamily = heldout.symmetryPolicy.positionFamilySha256;
  const counts = Object.fromEntries(SPLITS.map(function (split) {
    return [split, Object.fromEntries(PHASES.map(function (phase) {
      return [phase, 0];
    }))];
  }));
  const familyCounts = new Map();
  const clusters = new Set();
  const result = [];
  const target = quotaTotal(quotas);
  const attemptLimit = target * 250;

  for (let attempt = 0; attempt < attemptLimit && result.length < target; attempt++) {
    const wantedPhase = nextNeededPhase(quotas, counts);
    if (!wantedPhase) break;
    const pool = pools[wantedPhase];
    const source = pool[Math.floor(random() * pool.length)];
    const state = continuation(source, wantedPhase, random);
    if (!state) continue;
    let fen, phase, cluster, family;
    try {
      fen = Corpus.parseFen4(Chess.toFen(state)).fen4;
      phase = Corpus.phaseBucket(fen);
      cluster = Corpus.clusterKey(fen);
      family = Corpus.positionFamilyKey(fen);
    } catch (_) {
      // Some adversarial correctness seeds are parseable by the game fixture
      // but can reach an invalid king-capture continuation.  Such a state is
      // unusable for either feature extraction or a UCI teacher.
      continue;
    }
    if (phase !== wantedPhase) continue;
    if (cluster === incidentCluster || family === incidentFamily ||
        clusters.has(cluster) || (familyCounts.get(family) || 0) >= FAMILY_CAP) {
      continue;
    }
    const split = splitForFamily(family);
    if (counts[split][phase] >= quotas[split][phase]) continue;
    let row;
    try {
      row = makeRow(state, source, split, phase, cluster, family);
    } catch (_) {
      continue;
    }
    clusters.add(cluster);
    familyCounts.set(family, (familyCounts.get(family) || 0) + 1);
    counts[split][phase]++;
    result.push(row);
  }

  if (result.length !== target || currentTotal(counts) !== target) {
    throw new Error(
      'attempt limit reached before quotas: generated ' + result.length +
      ' of ' + target + ' rows; counts=' + JSON.stringify(counts)
    );
  }
  result.sort(function (left, right) {
    return SPLITS.indexOf(left.split) - SPLITS.indexOf(right.split) ||
      PHASES.indexOf(left.phase) - PHASES.indexOf(right.phase) ||
      left.id.localeCompare(right.id);
  });
  return { rows: result, quotas, counts };
}

function metadata() {
  const featureManifest = JSON.parse(fs.readFileSync(path.join(
    ROOT, 'eval', 'training', 'hce-r3-features-v1.json'
  ), 'utf8'));
  return {
    schema: 'chessy.hce-synthetic-pilot-metadata.v1',
    status: 'research-only-synthetic',
    qualityClaimAllowed: false,
    parameters: H.TOTAL_PARAMETER_COUNT,
    baselineParameters: H.BASELINE_PARAMETER_COUNT,
    parameterNames: H.PARAMETER_NAMES,
    center: Baseline.baselineCenter(),
    scales: Baseline.regularizationScales(),
    families: featureManifest.families,
    corpus: {
      path: path.relative(ROOT, CORPUS_PATH),
      sha256: sha256(fs.readFileSync(CORPUS_PATH))
    }
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.metadata) {
    process.stdout.write(JSON.stringify(metadata()) + '\n');
    return;
  }
  const generated = generate(options);
  for (const row of generated.rows) process.stdout.write(JSON.stringify(row) + '\n');
  process.stderr.write(
    'hce-synthetic-pilot-data: wrote ' + generated.rows.length +
    ' deterministic research-only rows\n'
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error('hce-synthetic-pilot-data: ' + error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_ROWS,
  DEFAULT_SEED,
  FAMILY_CAP,
  PHASES,
  SCHEMA,
  SPLITS,
  generate,
  metadata,
  parseArgs,
  rowQuotas,
  splitForFamily
};
