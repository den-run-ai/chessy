/* Read-only grouping audit. Counts describe overlap, never effective sample size. */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const Module = require('module');
const path = require('path');
const U = require('./ai-match-opening-utils-v2');
const Chess = globalThis.Chess;
const ROOT = path.join(__dirname, '..');
const REPORT = path.join(ROOT, 'eval/match-v2/holdout-audit.json');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

// Exactly the pawn/king/material representation in PR146 corpus.js at
// 1e01c0b. File reflection is a conservative STATIC training-family grouping,
// not a claim of legal game symmetry (castling prevents that interpretation).
// Deliberately independent of that unmerged 32k-line training foundation.
function structuralFamilyKey(fen) {
  Chess.parseFen(fen); // Validate the board before inspecting its placement.
  const ranks = fen.split(' ')[0].split('/').map(rank =>
    Array.from(rank).flatMap(char => /[1-8]/.test(char)
      ? Array(Number(char)).fill(null) : [char]));
  const representations = [];
  for (const fileMirror of [false, true]) {
    for (const colorRank of [false, true]) {
      const pawns = [], kings = [];
      const material = { P: 0, N: 0, B: 0, R: 0, Q: 0,
        p: 0, n: 0, b: 0, r: 0, q: 0 };
      for (let rank = 0; rank < 8; rank++) {
        for (let file = 0; file < 8; file++) {
          let piece = ranks[rank][file];
          if (!piece) continue;
          if (colorRank) piece = piece === piece.toUpperCase()
            ? piece.toLowerCase() : piece.toUpperCase();
          const square = (colorRank ? 7 - rank : rank) * 8 +
            (fileMirror ? 7 - file : file);
          if (piece.toLowerCase() === 'p') pawns.push(piece + square);
          else if (piece.toLowerCase() === 'k') kings.push(piece + square);
          else material[piece]++;
        }
      }
      representations.push(JSON.stringify({ pawns: pawns.sort(),
        kings: kings.sort(),
        material: Object.keys(material).sort().map(piece => [piece, material[piece]]) }));
    }
  }
  return hash(representations.sort()[0]);
}

function replay(row) {
  const result = U.replayPgn(row.pgn, row.id);
  const fen = Chess.toFen(result.state);
  if (row.fen !== undefined && row.fen !== fen) {
    throw new Error(row.id + ': recorded FEN differs from legal replay');
  }
  return { id: row.id, family: row.family, fen: fen,
    uci: result.uci, plies: result.plies,
    endpoint: U.positionCluster(fen), structural: structuralFamilyKey(fen) };
}

function groupSummary(keys) {
  const counts = new Map();
  for (const key of keys) counts.set(key, (counts.get(key) || 0) + 1);
  const histogram = {};
  for (const count of counts.values()) histogram[count] = (histogram[count] || 0) + 1;
  return { groups: counts.size, endpointsBeyondOnePerGroup: keys.length - counts.size,
    largestGroup: Math.max(0, ...counts.values()), groupsBySize: histogram };
}

function overlap(rows, exposed) {
  const endpoints = new Set(exposed.map(row => row.endpoint));
  const structures = new Set(exposed.map(row => row.structural));
  const continuations = rows.filter(row => exposed.some(prior =>
    prior.plies >= 6 && row.uci.startsWith(prior.uci + ' ')));
  return { exposedRecords: exposed.length,
    exposedEndpointEquivalenceGroups: endpoints.size,
    exposedStructuralFamilies: structures.size,
    endpointEquivalence: rows.filter(row => endpoints.has(row.endpoint)).length,
    structuralFamily: rows.filter(row => structures.has(row.structural)).length,
    strictContinuationOfExposedLineAtLeastSixPlies: continuations.length };
}

function audit(openings, exposedSources) {
  if (!Array.isArray(openings) || !openings.length || openings.length > 10000) {
    throw new Error('audit requires between 1 and 10000 openings');
  }
  const ids = new Set();
  for (const row of openings) {
    if (!row || typeof row.id !== 'string' || !row.id || ids.has(row.id) ||
        typeof row.family !== 'string' || !row.family) {
      throw new Error('each opening needs a distinct ID and named family');
    }
    ids.add(row.id);
  }
  const rows = openings.map(replay);
  const allExposed = [], bySource = {};
  for (const source of exposedSources) {
    if (!source || typeof source.id !== 'string' || !source.id ||
        Object.hasOwn(bySource, source.id) || !Array.isArray(source.openings) ||
        source.openings.length > 10000) throw new Error('invalid exposed source');
    const exposed = source.openings.map(replay);
    allExposed.push(...exposed);
    bySource[source.id] = overlap(rows, exposed);
  }
  const namedCounts = new Map();
  for (const row of rows) namedCounts.set(row.family, (namedCounts.get(row.family) || 0) + 1);
  return { endpoints: rows.length,
    endpointEquivalence: groupSummary(rows.map(row => row.endpoint)),
    staticStructuralFamilies: groupSummary(rows.map(row => row.structural)),
    namedOpeningFamilies: { ...groupSummary(rows.map(row => row.family)),
      counts: Object.fromEntries([...namedCounts].sort((a, b) =>
        b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) },
    exposureOverlap: { union: overlap(rows, allExposed), bySource: bySource } };
}

function currentReport() {
  const M = require('./ai-match-openings-v2');
  const paths = ['test/ai-match-openings.js', 'eval/corpus/sources/openings-v1.tsv'];
  const inputs = paths.map(filename => {
    const bytes = fs.readFileSync(path.join(ROOT, filename));
    const digest = hash(bytes);
    const expected = M.manifest.selection.exclusions.find(row => row.path === filename);
    if (!expected || expected.fileSha256 !== digest) throw new Error('exposure source changed: ' + filename);
    return { path: filename, sha256: digest, bytes: bytes };
  });
  // Execute the same retained bytes that were authenticated above.
  const priorModule = new Module(path.join(ROOT, paths[0]), module);
  priorModule.filename = path.join(ROOT, paths[0]);
  priorModule.paths = module.paths;
  priorModule._compile(inputs[0].bytes.toString('utf8'), priorModule.filename);
  const tsv = inputs[1].bytes.toString('utf8').trimEnd().split('\n');
  if (tsv.shift() !== 'eco\tname\tpgn') throw new Error('unexpected exposure TSV header');
  const sources = [
    { id: 'formal-match-v1', openings: priorModule.exports.map((row, index) =>
      ({ id: String(index), pgn: row[1] })) },
    { id: 'eval-corpus-v1', openings: tsv.map((line, index) => {
      const columns = line.split('\t');
      if (columns.length !== 3) throw new Error('invalid exposure TSV row');
      return { id: String(index), pgn: columns[2] };
    }) }
  ];
  return { schema: 'chessy.holdout-grouping-audit.v1', disposition: 'diagnostic-only',
    manifestSha256: M.sha256,
    implementationSha256: hash(fs.readFileSync(__filename)),
    replayHelperSha256: hash(fs.readFileSync(path.join(__dirname, 'ai-match-opening-utils-v2.js'))),
    exposureSources: inputs.map(({ path: filename, sha256 }) => ({ path: filename, sha256 })),
    definitions: {
      endpointEquivalence: 'Legal repetition position key, plus color/rank mirror; ignores move counters.',
      staticStructuralFamilies: 'PR146 at 1e01c0b: pawn squares, king squares, non-pawn material counts; file and color/rank reflection canonicalized. Ignores other piece squares and all FEN state fields.',
      namedOpeningFamilies: 'Catalog name before colon; descriptive taxonomy, not a statistical independence test.',
      strictContinuation: 'An entire exposed line of at least six plies is a strict UCI prefix of the selected line. Shared first moves alone do not qualify.'
    },
    sourceGameGrouping: { status: 'unavailable-for-opening-catalog',
      sourceGames: null, reason: M.manifest.source.sourceGameIdentityReason },
    independence: { established: false, effectiveSampleSize: null,
      conclusion: 'Neither unique endpoints, structural keys, nor named families prove independent outcomes. These counts do not authorize a formal estimator or acceptance threshold.' },
    counts: audit(M.openings, sources) };
}

function main(argv) {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== '--check')) {
    throw new Error('usage: node test/ai-match-holdout-audit.js [--check]');
  }
  const rendered = JSON.stringify(currentReport(), null, 2) + '\n';
  if (argv[0] === '--check') {
    if (fs.readFileSync(REPORT, 'utf8') !== rendered) throw new Error('holdout-audit.json is stale');
    console.log('holdout audit matches authenticated manifest and exposure sources');
  } else process.stdout.write(rendered);
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = Object.freeze({ structuralFamilyKey, audit, currentReport });
