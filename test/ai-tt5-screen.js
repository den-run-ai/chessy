/*
 * Shipped-budget time-to-depth screen — the production Master configuration
 * (iterative deepening, quiescence, maxDepth 30, a fixed wall-clock budget)
 * over the 9 bench families x mirrored 18 positions, working tree vs a git
 * ref. This is the "one more completed ply" evidence the #84/#113 throughput
 * roadmap asks from every retained optimization: an exact-tree speedup shows
 * up here as deeper completed iterations inside the same 5-second budget,
 * never as a changed tree at equal depth.
 *
 * Method: candidate and base engines live in separate persistent Node
 * processes (own V8 heap/JIT, see ai-tt5-worker.js). Per position both
 * engines get a symmetric warm-up think, then --pairs order-balanced AB/BA
 * rounds of one timed think each; the balanced order cancels slow host
 * drift. Timed runs keep scheduler/JIT noise, so completed-depth pair tallies
 * (deeper/tied/shallower) are the primary reading and per-run NPS the
 * secondary one. Budget overshoot (wall - budget) is reported per engine:
 * the deadline is checked between nodes, so overshoot bounds the engine's
 * worst uninterruptible span at this budget.
 *
 * Usage:
 *   node test/ai-tt5-screen.js --base origin/main             # 5000 ms screen
 *   node test/ai-tt5-screen.js --base HEAD~1 --time 2000
 *   node test/ai-tt5-screen.js --base main --pairs 4 --json out.json
 */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const args = process.argv.slice(2);
function opt(name, dflt) {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : dflt;
}
const BASE = opt('base', null);
if (!BASE) {
  console.error('usage: node test/ai-tt5-screen.js --base <git-ref> ' +
    '[--time 5000] [--pairs 2] [--warm 1000] [--json FILE]');
  process.exit(2);
}
function posInt(name, dflt) {
  const raw = opt(name, String(dflt));
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) {
    console.error('--' + name + ' must be a positive safe integer (got "' + raw + '")');
    process.exit(2);
  }
  return n;
}
const TIME_MS = posInt('time', 5000);
const PAIRS = posInt('pairs', 2);
const WARM_MS = posInt('warm', 1000);
const JSON_OUT = opt('json', null);
const WORKER_TIMEOUT_MS = 15 * 60 * 1000;

// Frozen copy of the test/ai-bench.js FAMILIES table (keep in sync): the
// screen must exercise exactly the families the fixed-depth gate tracks so a
// per-family regression there is visible here at the shipped budget too.
const FAMILIES = [
  ['opening (Ruy Lopez)', 'r1bqkb1r/1ppp1ppp/p1n2n2/4p3/B3P3/5N2/PPPP1PPP/RNBQ1RK1 b kq - 3 5'],
  ['open middlegame (Dragon)', 'r2q1rk1/pp1bppbp/2np1np1/8/3NP3/2N1B3/PPPQBPPP/R4RK1 w - - 0 1'],
  ['closed middlegame (KID)', 'r1bq1rk1/ppp1n1bp/3p2p1/3Pp3/2P1P3/2N2N2/PP3PPP/R1BQ1RK1 w - - 0 1'],
  ['tactical middlegame (Kiwipete)', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1'],
  ['rook ending (Lucena)', '1K1k4/1P6/8/8/8/8/r7/2R5 w - - 0 1'],
  ['minor-piece ending', '8/3k1p2/4p1p1/4n3/8/2B2P2/4K1P1/8 w - - 0 1'],
  ['promotion race', '8/1P3k2/8/8/8/8/1p3K2/8 w - - 0 1'],
  ['pawn ending (zugzwang)', '8/8/4k3/4p3/4P3/4K3/8/8 w - - 0 1'],
  ['tactical defence (chessy202607240238)', 'r3r1k1/1ppq1pp1/1b2n3/3pPN1Q/1P5B/3B3P/P5P1/2R4K b - - 0 27']
];

// Mirror a FEN vertically and swap colors (a1<->a8, White<->Black) — same
// transform as test/ai-bench.js.
function mirrorFen(fen) {
  const p = fen.split(' ');
  const swap = function (ch) {
    return ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase();
  };
  p[0] = p[0].split('/').reverse().map(function (rank) {
    return rank.split('').map(function (c) { return /\d/.test(c) ? c : swap(c); }).join('');
  }).join('/');
  p[1] = p[1] === 'w' ? 'b' : 'w';
  if (p[2] !== '-') p[2] = p[2].split('').map(swap).sort().join('');
  if (p[3] !== '-') p[3] = p[3][0] + (9 - Number(p[3][1]));
  return p.join(' ');
}
const POSITIONS = [];
for (const [name, fen] of FAMILIES) {
  POSITIONS.push([name, fen]);
  POSITIONS.push([name + ' (mirrored)', mirrorFen(fen)]);
}

function startWorker(ref) {
  const child = cp.fork(path.join(__dirname, 'ai-tt5-worker.js'),
    [ref || '__worktree__'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  let nextId = 1;
  let terminalError = null;
  let closing = false;
  let exited = false;
  const pending = new Map();
  let readyResolve, readyReject;
  const ready = new Promise(function (resolve, reject) {
    readyResolve = resolve;
    readyReject = reject;
  });
  function fail(error) {
    if (terminalError) return;
    terminalError = error instanceof Error ? error : new Error(String(error));
    readyReject(terminalError);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(terminalError);
    }
    pending.clear();
  }
  child.on('message', function (message) {
    if (message.type === 'startup-error') {
      fail(new Error(message.error));
      return;
    }
    if (message.type === 'ready') {
      readyResolve();
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.result);
  });
  child.on('error', fail);
  child.on('disconnect', function () {
    if (!closing) fail(new Error('timed worker IPC disconnected'));
  });
  child.on('exit', function (code, signal) {
    exited = true;
    if (!closing || pending.size) {
      fail(new Error('timed worker exited early (code ' + code +
        (signal ? ', signal ' + signal : '') + ')'));
    }
  });
  return {
    ready: ready,
    think: async function (fen, timeMs, seed) {
      await ready;
      if (terminalError) throw terminalError;
      return new Promise(function (resolve, reject) {
        const id = nextId++;
        const timer = setTimeout(function () {
          const request = pending.get(id);
          if (!request) return;
          pending.delete(id);
          request.reject(new Error('timed worker request timed out'));
        }, WORKER_TIMEOUT_MS);
        pending.set(id, { resolve: resolve, reject: reject, timer: timer });
        try {
          child.send({ type: 'think', id: id, fen: fen, timeMs: timeMs, seed: seed },
            function (error) {
              if (!error) return;
              const request = pending.get(id);
              if (!request) return;
              pending.delete(id);
              clearTimeout(request.timer);
              request.reject(error);
            });
        } catch (error) {
          const request = pending.get(id);
          pending.delete(id);
          clearTimeout(request.timer);
          reject(error);
        }
      });
    },
    close: function () {
      closing = true;
      return new Promise(function (resolve) {
        if (exited) { resolve(); return; }
        const fallback = setTimeout(function () {
          if (!exited) child.kill();
        }, 2000);
        child.once('exit', function () {
          clearTimeout(fallback);
          resolve();
        });
        if (child.connected) child.disconnect();
        else child.kill();
      });
    }
  };
}

// Nearest-rank quantile on an ascending-sorted array.
function quantile(sortedValues, q) {
  if (!sortedValues.length) return NaN;
  return sortedValues[Math.max(0, Math.ceil(q * sortedValues.length) - 1)];
}

async function main() {
  const cand = startWorker(null);
  const base = startWorker(BASE);
  console.log('time-to-depth screen: ' + TIME_MS + ' ms/move, maxDepth 30, quiesce; base ' + BASE);
  console.log('positions: ' + POSITIONS.length + ' (9 families, mirrored), ' + PAIRS +
    ' order-balanced AB/BA pairs each, ' + WARM_MS + ' ms symmetric warm-up');
  console.log('');

  let deeper = 0, tied = 0, shallower = 0;
  let logNpsSum = 0, candDepthSum = 0, baseDepthSum = 0;
  const rows = [];
  const overshoots = { cand: [], base: [] };
  const seedBase = 0xC0FFEE;
  try {
    await Promise.all([cand.ready, base.ready]);
    for (let positionIndex = 0; positionIndex < POSITIONS.length; positionIndex++) {
      const [name, fen] = POSITIONS[positionIndex];
      if (positionIndex % 2 === 0) {
        await cand.think(fen, WARM_MS, seedBase);
        await base.think(fen, WARM_MS, seedBase);
      } else {
        await base.think(fen, WARM_MS, seedBase);
        await cand.think(fen, WARM_MS, seedBase);
      }
      for (let round = 0; round < PAIRS; round++) {
        const seed = seedBase + round;
        const candFirst = (positionIndex + round) % 2 === 0;
        let c, b;
        if (candFirst) {
          c = await cand.think(fen, TIME_MS, seed);
          b = await base.think(fen, TIME_MS, seed);
        } else {
          b = await base.think(fen, TIME_MS, seed);
          c = await cand.think(fen, TIME_MS, seed);
        }
        if (c.depth > b.depth) deeper++;
        else if (c.depth === b.depth) tied++;
        else shallower++;
        logNpsSum += Math.log((c.nodes / c.wallMs) / (b.nodes / b.wallMs));
        candDepthSum += c.depth;
        baseDepthSum += b.depth;
        overshoots.cand.push(c.wallMs - TIME_MS);
        overshoots.base.push(b.wallMs - TIME_MS);
        rows.push({ name: name, round: round, candFirst: candFirst, cand: c, base: b });
        console.log(name.padEnd(42) +
          ' cand d' + String(c.depth).padEnd(2) + ' ' + String(c.nodes).padStart(7) + ' n' +
          ' | base d' + String(b.depth).padEnd(2) + ' ' + String(b.nodes).padStart(7) + ' n' +
          '  ' + (c.depth > b.depth ? 'cand deeper' :
            c.depth < b.depth ? 'BASE DEEPER' : 'tie') +
          '  [' + (candFirst ? 'AB' : 'BA') + ']');
      }
    }
  } finally {
    await Promise.all([cand.close(), base.close()]);
  }

  const rounds = rows.length;
  const oc = overshoots.cand.slice().sort(function (a, b) { return a - b; });
  const ob = overshoots.base.slice().sort(function (a, b) { return a - b; });
  console.log('');
  console.log('rounds: ' + rounds + '  candidate deeper ' + deeper + ', tied ' + tied +
    ', shallower ' + shallower);
  console.log('mean completed depth: cand ' + (candDepthSum / rounds).toFixed(2) +
    '  base ' + (baseDepthSum / rounds).toFixed(2));
  console.log('geomean paired NPS ratio (cand/base): ' +
    Math.exp(logNpsSum / rounds).toFixed(4));
  console.log('budget overshoot ms (wall - ' + TIME_MS + '): ' +
    'cand p50 ' + quantile(oc, 0.5).toFixed(1) + ' p95 ' + quantile(oc, 0.95).toFixed(1) +
    ' max ' + oc[oc.length - 1].toFixed(1) +
    ' | base p50 ' + quantile(ob, 0.5).toFixed(1) + ' p95 ' + quantile(ob, 0.95).toFixed(1) +
    ' max ' + ob[ob.length - 1].toFixed(1));
  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify({
      timeMs: TIME_MS, pairs: PAIRS, warmMs: WARM_MS, base: BASE,
      node: process.version,
      summary: { deeper: deeper, tied: tied, shallower: shallower },
      rows: rows
    }, null, 1));
    console.log('json: ' + JSON_OUT);
  }
}

main().catch(function (error) {
  console.error('FAIL: ' + (error && error.stack || error));
  process.exitCode = 1;
});
