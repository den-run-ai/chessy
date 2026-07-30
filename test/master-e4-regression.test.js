/*
 * Frozen reproduction for the 2026-07-29 Master game where r69 played
 * 11...Bd4 instead of the stronger 11...e4.
 *
 * The default mode is a CI-safe known-regression diagnostic. It proves the
 * source game and, while the shipped asset is the pinned r69 binary, reproduces
 * the exact historical search. It deliberately does not bless Bd4 as correct.
 * The binary is not duplicated as a test fixture: commit 8b887c4 plus its
 * recorded SHA is the immutable artifact. Once the shipped WASM hash changes,
 * exact r69 replay is intentionally skipped here and remains reproducible by
 * checking out that commit.
 *
 * Once an algorithmic change has passed the strength/device gates, make the
 * behavior mandatory with:
 *   node test/master-e4-regression.test.js --require-fix
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('../assets/engine.js');
require('../assets/pgn.js');
const WasmBench = require('../experiments/wasm/bench.js');

const FIXTURE_PATH = path.join(
  __dirname, 'fixtures', 'master-e4-regression-20260729.json');
const PGN_PATH = path.join(
  __dirname, 'fixtures', 'master-e4-regression-20260729.pgn');
const WASM_PATH = path.join(__dirname, '..', 'assets', 'chessy-ai-fast.wasm');
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
const rawPgn = fs.readFileSync(PGN_PATH, 'utf8');
const requireFix = process.argv.includes('--require-fix');
let passed = 0, failed = 0, skipped = 0;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function check(ok, label, detail) {
  if (ok) {
    passed++;
    console.log('  ok  ' + label);
  } else {
    failed++;
    console.error('FAIL  ' + label + (detail ? ' — ' + detail : ''));
  }
}

function skip(label, detail) {
  skipped++;
  console.log(' SKIP ' + label + (detail ? ' — ' + detail : ''));
}

function uci(move) {
  return Chess.sqName(move.from) + Chess.sqName(move.to) +
    (move.promotion ? move.promotion.toLowerCase() : '');
}

function replayAndVerifySource() {
  const game = ChessyPGN.parseGame(rawPgn);
  const regression = fixture.regression;
  check(fixture.source.filename === 'chessy-20260729-1804-debug.pgn',
    'source metadata keeps the canonical downloaded filename',
    fixture.source.filename);
  check(fixture.source.attachmentFilename ===
      'chessy-20260729-1804-debug(1).pgn',
    'source metadata distinguishes the uploaded attachment filename',
    fixture.source.attachmentFilename);
  check(sha256(rawPgn) === fixture.source.sha256,
    'raw debug PGN SHA-256 matches the supplied artifact', sha256(rawPgn));
  check(game.valid, 'debug PGN parses and replays legally', game.error);
  if (!game.valid) return;
  check(game.tags.Date === fixture.source.date &&
      game.tags.Result === fixture.result &&
      game.tags.Black === 'Chessy AI (Master)',
    'source tags identify the r69 Master game');
  check(game.moves.length === fixture.plies,
    'all 42 plies are present', String(game.moves.length));
  check(sha256(game.moves.map(function (move) { return move.san; }).join('\n')) ===
      fixture.sanSha256,
    'canonical SAN SHA-256 matches the frozen game');
  check(regression.playedUci === 'c5d4' && regression.playedSan === 'Bd4' &&
      regression.targetUci === 'e5e4' && regression.targetSan === 'e4',
    'regression metadata is bound to literal Bd4 and e4 identities');
  check(game.moves[regression.ply] &&
      game.moves[regression.ply].san === 'Bd4',
    'frozen PGN records 11...Bd4 at the regression ply');

  let state = Chess.newGameState();
  for (let ply = 0; ply < game.moves.length; ply++) {
    if (ply === regression.ply) {
      check(Chess.toFen(state) === regression.fen,
        'critical FEN is exact before 11...' + regression.playedSan,
        Chess.toFen(state));
      const legal = Chess.legalMoves(state);
      const played = legal.find(function (move) {
        return uci(move) === regression.playedUci;
      });
      const target = legal.find(function (move) {
        return uci(move) === regression.targetUci;
      });
      check(!!played && Chess.toSan(state, played, legal) === regression.playedSan,
        'historical 11...Bd4 is legal and mapped to c5d4');
      check(!!target && Chess.toSan(state, target, legal) === regression.targetSan,
        'regression target 11...e4 is legal and mapped to e5e4');
    }
    const legal = Chess.legalMoves(state);
    const move = legal.find(function (candidate) {
      return Chess.toSan(state, candidate, legal) === game.moves[ply].san;
    });
    if (!move) {
      check(false, 'replay resolves every canonical SAN',
        'failed at ply ' + (ply + 1) + ': ' + game.moves[ply].san);
      return;
    }
    state = Chess.playMove(state, move);
  }
  check(Chess.toFen(state) === fixture.finalFen,
    'final FEN matches the recorded mate', Chess.toFen(state));
  const status = Chess.gameStatus(state);
  check(status.over && status.result === fixture.result &&
      status.reason === fixture.reason,
    'replay ends in the recorded checkmate');
}

function verifyOracleFixture() {
  const regression = fixture.regression;
  const oracle = regression.pinnedOracle;
  const rows = oracle.forcedRoot;
  const moves = rows.map(function (row) { return row.moveUci; });
  const e4 = rows.find(function (row) {
    return row.moveUci === 'e5e4';
  });
  const bd4 = rows.find(function (row) {
    return row.moveUci === 'c5d4';
  });
  const legal = new Set(Chess.legalMoves(
    Chess.parseFen(regression.fen)).map(uci));
  check(oracle.candidateCount === 4 && oracle.exhaustiveLegalMoves === false &&
      rows.length === 4 && new Set(moves).size === 4,
    'pinned Stockfish Lite scope is four unique forced-root candidates');
  check(moves.every(function (move) { return legal.has(move); }),
    'all four forced-root candidates are legal in the frozen position');
  check(/four preselected legal moves/.test(oracle.scope) &&
      /not an exhaustive ranking/.test(oracle.scope),
    'oracle scope is explicitly non-exhaustive');
  check(!!e4 && rows.every(function (row) {
    return row === e4 || e4.scoreCp > row.scoreCp;
  }), 'Stockfish Lite ranks e4 first among the four tested moves');
  check(!!e4 && !!bd4 &&
      e4.scoreCp - bd4.scoreCp === oracle.targetVsPlayedMarginCp &&
      oracle.targetVsPlayedMarginCp === 48,
    'pinned e4 score exceeds Bd4 by the recorded 48 cp margin');
}

async function reproduceSearch() {
  const regression = fixture.regression;
  const baseline = regression.r69Replay;
  const assetSha = sha256(fs.readFileSync(WASM_PATH));
  const wasm = await WasmBench.loadWasmEngine(WASM_PATH, 'shipped WASM');
  const result = wasm.search(regression.fen, {
    maxDepth: baseline.maxDepth,
    nodeLimit: baseline.nodeLimit,
    timeMs: 0,
    quiesce: baseline.quiesce
  });
  const legalUci = Chess.legalMoves(Chess.parseFen(regression.fen)).map(uci);
  check(legalUci.includes(result.move), 'search returns a legal root move', result.move);
  check(result.stopReason === 'node-limit' &&
      result.nodes === baseline.nodeLimit &&
      result.attemptedDepth != null,
    'fixed-node replay stops coherently at the historical budget',
    JSON.stringify(result));

  if (assetSha === baseline.assetSha256) {
    check(result.move === baseline.moveUci &&
        result.score === baseline.scoreWhitePov &&
        result.depth === baseline.depth &&
        result.attemptedDepth === baseline.attemptedDepth &&
        result.nodes === baseline.nodes &&
        result.qnodes === baseline.qnodes &&
        result.stopReason === baseline.stopReason,
      'pinned r69 WASM exactly reproduces 11...Bd4 and its search signature',
      JSON.stringify(result));
  } else {
    skip('exact r69 search signature', 'shipped WASM hash changed; replay ' +
      baseline.commit + ':' + baseline.asset);
  }

  const fixed = result.move === regression.targetUci;
  if (requireFix) {
    check(fixed, 'current engine selects the oracle target 11...e4',
      'got ' + result.move);
  } else {
    console.log('  ' + (fixed ? 'ok  ' : 'KNOWN ') +
      'current engine ' + (fixed ? 'selects' : 'still misses') +
      ' the oracle target 11...e4' +
      (fixed ? '' : ' (use --require-fix to gate a candidate)'));
  }
}

async function main() {
  replayAndVerifySource();
  verifyOracleFixture();
  await reproduceSearch();
  console.log('\n' + passed + ' passed, ' + failed + ' failed, ' +
    skipped + ' skipped');
  process.exitCode = failed ? 1 : 0;
}

main().catch(function (error) {
  console.error('FAIL: ' + (error && error.stack || error));
  process.exitCode = 1;
});
