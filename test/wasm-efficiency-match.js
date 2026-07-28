/*
 * Formal Rust/WASM efficiency non-inferiority match.
 *
 * This runner deliberately has no configurable search budget or sample size:
 *   10,000 nodes/move x 100 frozen openings x 4 seed slots x both colours,
 *   with a 180-ply cap. Each invocation owns one 20-opening/one-seed shard.
 * The complete 800-game aggregate passes only when the opening-clustered
 * one-sided 95% lower confidence bound is strictly above 49%.
 *
 * The raw WASM ABI does not accept a root-order seed or game-prefix repetition
 * history. Every search therefore uses the module's embedded 0xC0FFEE shuffle,
 * and the four protocol seed slots are deterministic repeats. They are retained
 * to keep the frozen 100x4x2 manifest and shard geometry; statistics still use
 * the 100 openings as the independent clusters, never the 400 pairs.
 *
 * Usage (one formal shard):
 *   node test/wasm-efficiency-match.js \
 *     --candidate-wasm /path/to/candidate.wasm \
 *     --reference-wasm /path/to/reference.wasm \
 *     --candidate-sha <40-hex> --base-sha <40-hex> \
 *     --harness-sha <40-hex> \
 *     --seedbase 0 --openbase 0
 *
 * Fast manifest-only validation:
 *   node test/wasm-efficiency-match.js --check-openings
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
require('../assets/engine.js');
const Chess = globalThis.Chess;
const WasmEngine = require('../assets/wasm-engine.js');
const MatchProtocol = require('./ai-match-protocol');
const OPENINGS = require('./ai-match-openings');
const { clusterStats } = require('./match-stats');

const PROTOCOL = MatchProtocol.PROTOCOLS.wasmEfficiencyFixedNode;
const MAX_DEPTH = 30;
const NODES = PROTOCOL.budgetValue;
const MAX_PLIES = PROTOCOL.maxPlies;
const SHARD_OPENINGS = 20;
const PROBE_NODES = 3000;
const MATE_NEAR = 999000;
const SHA_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const FIXED_NODE_STOP_REASONS = new Set([
  'node-limit', 'max-depth', 'mate'
]);
const VALUE_OPTIONS = new Set([
  'candidate-wasm', 'reference-wasm', 'candidate-sha', 'base-sha',
  'harness-sha', 'seedbase', 'openbase'
]);

function usageError(message) {
  const error = new Error(message);
  error.exitCode = 2;
  return error;
}

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === '--check-openings') {
    return { checkOpenings: true };
  }
  const values = new Map();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      throw usageError('unexpected positional argument "' + arg + '"');
    }
    const name = arg.slice(2);
    if (!VALUE_OPTIONS.has(name)) {
      throw usageError('unknown option --' + name);
    }
    if (values.has(name)) {
      throw usageError('--' + name + ' may be supplied at most once');
    }
    const value = argv[++index];
    if (!value || value.startsWith('--')) {
      throw usageError('--' + name + ' requires a value');
    }
    values.set(name, value);
  }

  function required(name) {
    const value = values.get(name);
    if (!value) throw usageError('--' + name + ' is required');
    return value;
  }
  function coordinate(name, fallback, allowed) {
    const raw = values.has(name) ? values.get(name) : String(fallback);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || !allowed.includes(value)) {
      throw usageError('--' + name + ' must be one of ' +
        allowed.join(', ') + ' (got "' + raw + '")');
    }
    return value;
  }

  const candidateSha = required('candidate-sha');
  const baseSha = required('base-sha');
  const harnessSha = required('harness-sha');
  if (!SHA_RE.test(candidateSha) || !SHA_RE.test(baseSha) ||
      !SHA_RE.test(harnessSha)) {
    throw usageError('--candidate-sha, --base-sha and --harness-sha must ' +
      'be canonical 40-character lowercase commit SHAs');
  }
  if (candidateSha === baseSha) {
    throw usageError('formal WASM efficiency protocol requires distinct ' +
      'candidate and base commits');
  }

  return {
    checkOpenings: false,
    candidateWasm: path.resolve(required('candidate-wasm')),
    referenceWasm: path.resolve(required('reference-wasm')),
    candidateSha,
    baseSha,
    harnessSha,
    seedbase: coordinate('seedbase', 0, [0, 1, 2, 3]),
    openbase: coordinate('openbase', 0, [0, 20, 40, 60, 80])
  };
}

function openingState(sans) {
  const strip = function (san) { return san.replace(/[+#]$/, ''); };
  let state = Chess.newGameState();
  for (const san of sans.split(' ')) {
    const legal = Chess.legalMoves(state);
    const hits = legal.filter(function (move) {
      return strip(Chess.toSan(state, move, legal)) === strip(san);
    });
    if (hits.length !== 1) {
      throw new Error('opening token "' + san + '" matched ' + hits.length +
        ' moves in "' + sans + '"');
    }
    state = Chess.playMove(state, hits[0]);
  }
  return state;
}

function validateOpenings() {
  const seen = new Map();
  const errors = [];
  for (let index = 0; index < OPENINGS.length; index++) {
    const name = OPENINGS[index][0];
    try {
      const state = openingState(OPENINGS[index][1]);
      if (Chess.gameStatus(state).over) {
        errors.push(name + ': terminal after opening');
        continue;
      }
      const fen4 = Chess.toFen(state).split(' ').slice(0, 4).join(' ');
      if (seen.has(fen4)) {
        errors.push(name + ': duplicate of ' + seen.get(fen4));
        continue;
      }
      seen.set(fen4, name);
    } catch (error) {
      errors.push(name + ': ' + error.message);
    }
  }
  return errors;
}

function sha256(bytes) {
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  if (!DIGEST_RE.test(digest)) throw new Error('failed to compute canonical SHA-256');
  return digest;
}

function assertFixedNodeResult(result, label, nodeBudget, fen, ply) {
  const where = label +
    (Number.isSafeInteger(ply) ? ' at game ply ' + (ply + 1) : '') +
    (fen ? ' (' + fen + ')' : '');
  if (!result || !Number.isSafeInteger(result.nodes) ||
      result.nodes <= 0 || result.nodes > nodeBudget) {
    throw new Error(where + ' violated the ' + nodeBudget +
      '-node budget (searched ' +
      JSON.stringify(result && result.nodes) + ')');
  }
  if (!Number.isSafeInteger(result.qnodes) || result.qnodes < 0 ||
      result.qnodes > result.nodes) {
    throw new Error(where + ' returned invalid qnodes ' +
      JSON.stringify(result.qnodes) + ' for ' + result.nodes + ' nodes');
  }
  if (!Number.isSafeInteger(result.score) ||
      !Number.isSafeInteger(result.depth) ||
      result.depth < 0 || result.depth > MAX_DEPTH ||
      (result.attemptedDepth !== null &&
        (!Number.isSafeInteger(result.attemptedDepth) ||
          result.attemptedDepth < 1 ||
          result.attemptedDepth > MAX_DEPTH))) {
    throw new Error(where + ' returned incoherent score/depth metadata');
  }
  if (!FIXED_NODE_STOP_REASONS.has(result.stopReason)) {
    throw new Error(where + ' returned invalid fixed-node stopReason ' +
      JSON.stringify(result.stopReason));
  }
  if (result.stopReason === 'node-limit' && result.nodes !== nodeBudget) {
    throw new Error(where + ' reported node-limit after ' + result.nodes +
      ' nodes instead of the requested ' + nodeBudget);
  }
  if (result.stopReason === 'node-limit' &&
      result.attemptedDepth !== null &&
      result.attemptedDepth !== result.depth + 1) {
    throw new Error(where + ' reported inconsistent node-limit depth ' +
      '(depth ' + result.depth + ', attemptedDepth ' +
      result.attemptedDepth + ')');
  }
  if (result.stopReason === 'max-depth' &&
      (result.depth !== MAX_DEPTH || result.attemptedDepth !== null)) {
    throw new Error(where + ' reported inconsistent max-depth completion ' +
      '(depth ' + JSON.stringify(result.depth) + ', attemptedDepth ' +
      JSON.stringify(result.attemptedDepth) + ')');
  }
  if (result.stopReason === 'mate' &&
      (Math.abs(result.score) < MATE_NEAR ||
        result.depth < 1 || result.attemptedDepth !== null)) {
    throw new Error(where + ' reported inconsistent mate completion ' +
      '(score ' + result.score + ', depth ' + result.depth +
      ', attemptedDepth ' + JSON.stringify(result.attemptedDepth) + ')');
  }
}

function assertBounded(engine, label) {
  const result = engine.search(Chess.START_FEN, {
    maxDepth: MAX_DEPTH,
    nodeLimit: PROBE_NODES,
    timeMs: 0,
    quiesce: true
  });
  assertFixedNodeResult(
    result, label + ' startup probe', PROBE_NODES, Chess.START_FEN, null);
  if (result.stopReason !== 'node-limit') {
    throw new Error(label + ' does not honor the fixed-node contract ' +
      '(searched ' + result.nodes + ', stopReason ' +
      JSON.stringify(result.stopReason) + ' for ' + PROBE_NODES + ' nodes)');
  }
}

function scoreForWhite(status) {
  return status.result === '1-0' ? 1 : status.result === '0-1' ? 0 : 0.5;
}

function resolveMove(state, result) {
  const legal = Chess.legalMoves(state);
  return result.move && legal.find(function (move) {
    return move.from === result.move.from &&
      move.to === result.move.to &&
      move.promotion === result.move.promotion;
  });
}

function playGame(engines, sans, candidate, telemetry) {
  let state = openingState(sans);
  let plies = 0;
  while (plies < MAX_PLIES) {
    const status = Chess.gameStatus(state);
    if (status.over) return scoreForWhite(status);

    const engine = engines[state.turn === 'w' ? 0 : 1];
    const fen = Chess.toFen(state);
    const result = engine.search(fen, {
      maxDepth: MAX_DEPTH,
      nodeLimit: NODES,
      timeMs: 0,
      quiesce: true
    });
    assertFixedNodeResult(
      result,
      (engine === candidate ? 'candidate' : 'reference') +
        ' WASM',
      NODES,
      fen,
      plies
    );
    if (engine === candidate) {
      telemetry.moves++;
      const depth = result.depth || 0;
      telemetry.depths[depth] = (telemetry.depths[depth] || 0) + 1;
      if (depth >= 5) telemetry.depthGe5++;
    }
    const move = resolveMove(state, result);
    if (!move) {
      throw new Error('engine returned no legal move at ' + Chess.toFen(state));
    }
    state = Chess.playMove(state, move);
    plies++;
  }

  const finalStatus = Chess.gameStatus(state);
  return finalStatus.over ? scoreForWhite(finalStatus) : 0.5;
}

function validateWorkflowRun(value) {
  if (value &&
      !/^https:\/\/[^\s]+\/actions\/runs\/[0-9]+$/.test(value)) {
    throw usageError('CHESSY_WORKFLOW_RUN must be a canonical Actions run URL');
  }
  return value || null;
}

async function runMatch(config, environment) {
  const candidateBytes = fs.readFileSync(config.candidateWasm);
  const referenceBytes = fs.readFileSync(config.referenceWasm);
  const candidateDigest = sha256(candidateBytes);
  const referenceDigest = sha256(referenceBytes);
  const loaded = await Promise.all([
    WasmEngine.load(candidateBytes),
    WasmEngine.load(referenceBytes)
  ]);
  const candidate = loaded[0];
  const reference = loaded[1];
  assertBounded(candidate, 'candidate WASM');
  assertBounded(reference, 'reference WASM');

  const telemetry = { moves: 0, depthGe5: 0, depths: {} };
  const records = [];
  const pairScores = [];
  let wins = 0;
  let draws = 0;
  let losses = 0;
  let games = 0;
  const started = Date.now();
  const openLimit = config.openbase + SHARD_OPENINGS;
  for (let opening = config.openbase; opening < openLimit; opening++) {
    const gameSeed =
      MatchProtocol.deriveGameSeed(opening, config.seedbase);
    const asWhite = playGame(
      [candidate, reference], OPENINGS[opening][1], candidate, telemetry);
    const asBlack = 1 - playGame(
      [reference, candidate], OPENINGS[opening][1], candidate, telemetry);
    const pair = (asWhite + asBlack) / 2;
    pairScores.push(pair);
    records.push({
      op: opening,
      name: OPENINGS[opening][0],
      seed: config.seedbase,
      gseed: gameSeed,
      white: asWhite,
      black: asBlack,
      pair
    });
    for (const score of [asWhite, asBlack]) {
      games++;
      if (score === 1) wins++;
      else if (score === 0) losses++;
      else draws++;
    }
    process.stderr.write('\r' + games + ' games (' +
      OPENINGS[opening][0] + ', seed slot ' + config.seedbase + ')  W' +
      wins + ' D' + draws + ' L' + losses + '  ' +
      Math.round((Date.now() - started) / 1000) + 's   ');
  }
  process.stderr.write('\n');

  const stats = clusterStats(records);
  const workflowRun = validateWorkflowRun(environment.CHESSY_WORKFLOW_RUN);
  const depthPercent = telemetry.moves
    ? 100 * telemetry.depthGe5 / telemetry.moves
    : 0;

  console.log('protocol-id: ' + PROTOCOL.id);
  console.log('acceptance-class: ' + PROTOCOL.acceptanceClass);
  console.log('lower-bound-threshold: ' + PROTOCOL.lowerBoundThreshold);
  console.log('candidate-sha: ' + config.candidateSha);
  console.log('base-sha: ' + config.baseSha);
  console.log('harness-sha: ' + config.harnessSha);
  console.log('candidate-wasm-sha256: ' + candidateDigest);
  console.log('base-wasm-sha256: ' + referenceDigest);
  console.log('budget-mode: ' + PROTOCOL.budgetMode);
  console.log('budget-value: ' + PROTOCOL.budgetValue);
  console.log('max-plies: ' + PROTOCOL.maxPlies);
  console.log('openings-manifest-version: ' +
    MatchProtocol.OPENINGS_MANIFEST_VERSION);
  console.log('openings-manifest-sha256: ' +
    MatchProtocol.OPENINGS_MANIFEST_SHA256);
  console.log('node-runtime: ' + process.version);
  if (workflowRun) console.log('workflow-run: ' + workflowRun);
  console.log('pair-scores: ' + JSON.stringify(pairScores));
  console.log('records: ' + JSON.stringify(records));
  console.log('openings-total: ' + OPENINGS.length);
  console.log('shard: openings [' + config.openbase + ',' + openLimit +
    ') seeds [' + config.seedbase + ',' + (config.seedbase + 1) + ')');
  console.log('depth-dist: ' + JSON.stringify(telemetry.depths));
  console.log('completed-depth: ' + telemetry.depthGe5 + '/' +
    telemetry.moves + ' candidate moves reached depth >= 5 (' +
    depthPercent.toFixed(1) + '%)');
  console.log('candidate WASM vs frozen-base WASM: ' + games +
    ' games, ' + NODES + ' nodes/move');
  console.log('W ' + wins + ' / D ' + draws + ' / L ' + losses +
    '  score ' + (stats.mean * 100).toFixed(2) +
    '%  one-sided 95% lower bound ' + (stats.lo95 * 100).toFixed(2) +
    '% over ' + stats.nClusters + ' openings (' + stats.nPairs + ' pairs)');
  console.log('FORMAL SHARD: no verdict — efficiency non-inferiority verdict ' +
    'is reserved for the complete 800-game aggregation');

  return {
    candidateDigest,
    referenceDigest,
    records,
    stats,
    telemetry
  };
}

async function main(argv, environment) {
  let config;
  try {
    config = parseArgs(argv);
    const openingErrors = validateOpenings();
    if (openingErrors.length) {
      for (const error of openingErrors) console.error('FAIL ' + error);
      console.error(OPENINGS.length + ' openings checked, ' +
        openingErrors.length + ' bad');
      return 1;
    }
    if (config.checkOpenings) {
      console.log(OPENINGS.length + ' openings checked, 0 bad');
      return 0;
    }
    await runMatch(config, environment);
    return 0;
  } catch (error) {
    console.error('FAIL: ' + (error && error.message || error));
    return error && error.exitCode || 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2), process.env).then(function (exitCode) {
    process.exitCode = exitCode;
  });
}

module.exports = {
  PROTOCOL,
  OPENINGS,
  parseArgs,
  openingState,
  validateOpenings,
  assertFixedNodeResult,
  resolveMove,
  playGame,
  runMatch,
  main
};
