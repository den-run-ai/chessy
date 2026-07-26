/*
 * Manual independent-oracle reproduction for the exact screenshot game.
 *
 *   npm install --no-save stockfish@18.0.8
 *   node test/oracle/master-incident-stockfish.js
 *
 * The GPL engine remains an external dev-only process/module; it is not
 * bundled into Chessy's MIT-licensed offline app or run in ordinary PR CI.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let initStockfish;
try {
  initStockfish = require('stockfish');
} catch (e) {
  console.error('Install the pinned oracle first: npm install --no-save stockfish@18.0.8');
  process.exit(2);
}

const incident = require('../fixtures/master-incident-20260724.json');
const expected = incident.oracle;

// The package entry is `stockfish/src/stockfish.js`, not the package root.
// Walk upward to the manifest instead of assuming one dirname is sufficient;
// this also remains correct if a later pinned build nests its entry differently.
function findPackageRoot(entry, packageName) {
  let dir = path.dirname(entry);
  while (true) {
    const manifestPath = path.join(dir, 'package.json');
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest.name === packageName) {
        return { root: dir, manifest: manifest };
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error('could not resolve the ' + packageName + ' package root');
    }
    dir = parent;
  }
}

const stockfishPackage = findPackageRoot(
  require.resolve('stockfish'), 'stockfish');
const packageRoot = stockfishPackage.root;
const packageJson = stockfishPackage.manifest;

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function scoreFrom(line) {
  const match = line && line.match(/\bscore (cp|mate) (-?\d+)/);
  return match ? { type: match[1], value: Number(match[2]) } : null;
}

async function main() {
  const jsFile = path.join(packageRoot, 'bin', 'stockfish-18-single.js');
  const wasmFile = path.join(packageRoot, 'bin', 'stockfish-18-single.wasm');
  if ('stockfish@' + packageJson.version !== expected.package ||
      expected.flavor !== 'single' ||
      sha256(jsFile) !== expected.jsSha256 ||
      sha256(wasmFile) !== expected.wasmSha256) {
    throw new Error('installed Stockfish build does not match the frozen oracle');
  }

  const engine = await initStockfish(expected.flavor);
  let waiter = null;
  let engineId = null;
  engine.listener = function (line) {
    const id = line.match(/^id name (.+)$/);
    if (id) engineId = id[1];
    if (waiter) waiter(line);
  };
  function send(command) { engine.sendCommand(command); }
  function waitFor(wanted) {
    return new Promise(function (resolve) {
      waiter = function (line) {
        if (line === wanted) {
          waiter = null;
          resolve();
        }
      };
    });
  }
  async function ready() {
    const done = waitFor('readyok');
    send('isready');
    await done;
  }

  const uci = waitFor('uciok');
  send('uci');
  await uci;
  if (engineId !== expected.engineId) {
    throw new Error('engine id mismatch: ' + engineId);
  }
  send('setoption name Threads value ' + expected.threads);
  send('setoption name Hash value ' + expected.hashMb);
  send('setoption name MultiPV value ' + expected.multiPv);
  await ready();

  async function probe(fen, forcedMove) {
    if (expected.uciNewGameBeforeEach) send('ucinewgame');
    if (expected.clearHashBeforeEach) send('setoption name Clear Hash');
    await ready();
    send('position fen ' + fen);
    return new Promise(function (resolve) {
      let exact = null;
      waiter = function (line) {
        if (line.startsWith('info depth ' + expected.depth + ' ') &&
            line.includes(' pv ')) {
          exact = line;
        }
        if (line.startsWith('bestmove ')) {
          waiter = null;
          resolve({
            move: line.split(/\s+/)[1],
            score: scoreFrom(exact),
            pv: exact && exact.split(' pv ')[1]
          });
        }
      };
      send('go depth ' + expected.depth +
        (forcedMove ? ' searchmoves ' + forcedMove : ''));
    });
  }

  const critical = new Map(incident.critical.map(function (entry) {
    return [entry.ply, entry];
  }));
  let failures = 0;
  for (const label of expected.positions) {
    const entry = critical.get(label.ply);
    if (!entry || expected.scorePov !== 'black' ||
        entry.fen.split(/\s+/)[1] !== 'b') {
      throw new Error('oracle score POV does not match the critical position');
    }
    const best = await probe(entry.fen, null);
    const forced = new Map();
    async function resultFor(uci) {
      if (uci === best.move) return best;
      if (!forced.has(uci)) forced.set(uci, await probe(entry.fen, uci));
      return forced.get(uci);
    }
    const played = await resultFor(label.playedUci);
    const admitted = [];
    for (const move of label.admitted) {
      const result = await resultFor(move.uci);
      admitted.push({
        uci: move.uci,
        expectedCp: move.cp,
        actualCp: result.score && result.score.value,
        ok: result.move === move.uci && result.score &&
          result.score.type === 'cp' && result.score.value === move.cp
      });
    }
    const ok = best.move === label.bestUci &&
      best.score && best.score.type === 'cp' && best.score.value === label.bestCp &&
      played.move === label.playedUci &&
      played.score && played.score.type === 'cp' &&
      played.score.value === label.playedCp &&
      admitted.every(function (move) { return move.ok; });
    console.log(JSON.stringify({
      ply: label.ply,
      ok: ok,
      best: best,
      played: played,
      admitted: admitted,
      regretCp: best.score && played.score
        ? best.score.value - played.score.value : null
    }));
    if (!ok) failures++;
  }
  send('quit');
  if (failures) throw new Error(failures + ' frozen oracle probe(s) diverged');
}

main().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
