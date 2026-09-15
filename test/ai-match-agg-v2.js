/* Replay and aggregate all 20 authenticated shards from one registration.
 * Digest checks bind data to a trusted Actions run, not to a malicious host.
 * Results are descriptive; this implementation cannot authorize production.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('./ai-match-v2-core');
const O = require('./ai-match-openings-v2');
const P = require('./ai-match-protocol-v2');
const { clusterStats } = require('./match-stats');
const Chess = globalThis.Chess;

function tally() { return { moves: 0, nodes: 0, elapsedMs: 0, depthSum: 0, depth: {} }; }
function aggregate(buffers, r, registrationSha256) {
  // Internal replay helper: CLI callers must first authenticate the external
  // digest and local trusted Git/runtime identities with readRegistration().
  C.validateRegistration(r, false);
  C.check(C.sha256(C.canonical(r) + '\n') === registrationSha256, 'registration/expected digest mismatch');
  C.check(buffers.length === 20, 'exactly 20 complete shards required');
  const slots = new Set(), gameScores = new Map();
  const telemetry = { candidate: tally(), base: tally() };
  for (const bytes of buffers) {
    const rows = C.parseCanonicalLines(bytes);
    const footer = rows.pop(), header = rows.shift();
    C.check(footer && footer.type === 'complete' && footer.games === 40 && footer.rows === rows.length + 1,
      'missing or invalid completion footer');
    const prefix = Buffer.from(bytes.toString('utf8').split('\n').slice(0, -2).join('\n') + '\n');
    C.same(footer, { type: 'complete', rows: rows.length + 1, games: 40, sha256: C.sha256(prefix) }, 'raw byte digest');
    C.integer(header.slot, 0, 19, 'shard slot');
    C.same(header, { type: 'header', schema: 'chessy-match-v2-raw-1', slot: header.slot,
      registrationSha256 }, 'raw header');
    C.check(!slots.has(header.slot), 'duplicate shard'); slots.add(header.slot);
    let cursor = 0;
    for (let op = header.slot * 20; op < (header.slot + 1) * 20; op++) {
      for (const color of ['w', 'b']) {
        const opening = O.openings[op], game = opening.id + ':' + color;
        C.same(rows[cursor++], { type: 'start', game, opening: op, candidateColor: color }, 'game schedule');
        let state = C.initialState(opening), ply = 0;
        while (!C.outcome(state, ply, P.CONTRACT.maxPlies)) {
          const row = rows[cursor++];
          C.check(row && row.type === 'move', 'missing move or premature termination');
          const side = state.turn === color ? 'candidate' : 'base';
          C.same(Object.keys(row).sort(), ['type', 'game', 'ply', 'side', 'fen', 'historySha256', 'move', 'search'].sort(), 'move fields');
          C.same({ game: row.game, ply: row.ply, side: row.side, fen: row.fen, history: row.historySha256 },
            { game, ply, side, fen: Chess.toFen(state), history: C.historyHash(state) }, 'replayed search context');
          C.same(Object.keys(row.search).sort(), ['score', 'scorePov', 'depth', 'attemptedDepth', 'nodes',
            'qnodes', 'cutoffs', 'researches', 'stopReason', 'elapsedMs'].sort(), 'search fields');
          C.validateSearch(row.search, r.protocol.nodes);
          const t = telemetry[side];
          t.moves++; t.nodes += row.search.nodes; t.elapsedMs += row.search.elapsedMs;
          t.depthSum += row.search.depth;
          t.depth[row.search.depth] = (t.depth[row.search.depth] || 0) + 1;
          state = Chess.playMove(state, C.legalMove(state, row.move)); ply++;
        }
        const terminal = C.outcome(state, ply, P.CONTRACT.maxPlies);
        C.same(rows[cursor++], { type: 'end', game, ply, ...terminal, fen: Chess.toFen(state) }, 'terminal adjudication');
        const white = terminal.result === '1-0' ? 1 : terminal.result === '0-1' ? 0 : 0.5;
        gameScores.set(game, color === 'w' ? white : 1 - white);
      }
    }
    C.check(cursor === rows.length, 'unexpected extra/failure/duplicate records');
  }
  const pairs = O.openings.map(o => ({ op: o.id,
    pair: (gameScores.get(o.id + ':w') + gameScores.get(o.id + ':b')) / 2 }));
  const s = clusterStats(pairs);
  C.check(gameScores.size === 800 && s.nClusters === 400, 'incomplete opening/color inventory');
  return { schema: 'chessy-match-v2-summary-1', admission: P.CONTRACT.admission,
    registrationSha256, run: r.run, profile: r.profile, protocol: r.protocol,
    games: 800, openingEndpoints: 400, mean: s.mean, sd: s.sd, lower95: s.lo95,
    endpointThresholdExceeded: s.lo95 > r.protocol.lowerBoundThreshold,
    endpointStrengthThresholdExceeded: s.lo95 > 0.50,
    formalPass: false,
    limitations: ['Opening endpoints are correlated; family policy remains unresolved.',
      'Fixed-node timing/depth telemetry is descriptive, not a product-device efficiency gate.',
      'Source/build hashes record identity; independent build reproduction and correctness gates are required.'],
    telemetry };
}
function main(argv) {
  const { args } = require('./ai-match-v2');
  // Directory is intentionally a separate CLI field from runner options.
  C.check(argv.length === 6 && argv[0] === '--registration' && argv[2] === '--registration-sha256' && argv[4] === '--directory',
    'usage: --registration FILE --registration-sha256 HASH --directory DIR');
  const a = args(argv.slice(0, 4));
  const r = C.readRegistration(a.registration, a['registration-sha256']);
  const names = fs.readdirSync(argv[5]).sort();
  C.same(names, Array.from({ length: 20 }, (_, i) => 'slot-' + i + '.jsonl').sort(), 'artifact directory inventory');
  const buffers = names.map(name => {
    const file = path.join(argv[5], name);
    C.check(fs.lstatSync(file).isFile(), 'raw shard must be a regular file');
    return fs.readFileSync(file);
  });
  const summary = aggregate(buffers, r, a['registration-sha256']);
  console.log(JSON.stringify(summary, null, 2));
}
if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error('FAIL: ' + error.message); process.exitCode = 2; }
}
module.exports = { aggregate, main };
