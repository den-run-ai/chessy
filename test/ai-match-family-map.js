/* Prospective dependency/exposure map; never a search or admission verdict. */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const U = require('./ai-match-opening-utils-v2');
const Audit = require('./ai-match-holdout-audit');
const Chess = globalThis.Chess;
const ROOT = path.join(__dirname, '..');
const OUTPUT = path.join(ROOT, 'eval/match-v2/family-map.json');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const canonical = value => value && typeof value === 'object'
  ? Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
    : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  : JSON.stringify(value);
const ordered = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function replay(row, named) {
  if (!row || typeof row.id !== 'string' || !row.id ||
      (named && (typeof row.family !== 'string' || !row.family))) {
    throw new Error('distinct nonempty endpoint IDs and named families required');
  }
  const result = U.replayPgn(row.pgn, row.id);
  const fen = Chess.toFen(result.state);
  if (row.fen !== undefined && row.fen !== fen) throw new Error('FEN differs from legal replay');
  return { id: row.id, namedFamily: named ? row.family : null,
    endpoint: U.positionCluster(fen), structuralFamily: Audit.structuralFamilyKey(fen),
    uci: result.uci, plies: result.plies };
}
function lineRelated(a, b) {
  // Include both directions. A shorter candidate prefix of exposed work is
  // not a fresh line either. Equality is covered by endpoint equivalence.
  return (a.plies >= 6 && b.uci.startsWith(a.uci + ' ')) ||
    (b.plies >= 6 && a.uci.startsWith(b.uci + ' '));
}
function relations(a, b, named) {
  const reasons = [];
  if (a.endpoint === b.endpoint) reasons.push('endpoint-equivalence');
  if (a.structuralFamily === b.structuralFamily) reasons.push('structural-family');
  if (named && a.namedFamily === b.namedFamily) reasons.push('named-family');
  if (lineRelated(a, b)) reasons.push('complete-line-prefix-at-least-six-plies');
  return reasons;
}
function buildMap(openings, exposedSources) {
  if (!Array.isArray(openings) || !openings.length || openings.length > 10000 ||
      !Array.isArray(exposedSources)) throw new Error('invalid complete map inventory');
  const rows = openings.map(row => replay(row, true)).sort((a, b) => ordered(a.id, b.id));
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('duplicate endpoint ID');
  const sources = new Set(), exposed = [];
  for (const source of exposedSources) {
    if (!source || typeof source.id !== 'string' || !source.id || sources.has(source.id) ||
        !Array.isArray(source.openings) || source.openings.length > 10000) throw new Error('invalid exposure source');
    sources.add(source.id);
    const ids = new Set();
    for (const row of source.openings) {
      const item = replay(row, false);
      if (ids.has(item.id)) throw new Error('duplicate exposed ID');
      ids.add(item.id); exposed.push({ ...item, source: source.id });
    }
  }
  exposed.sort((a, b) => ordered(a.source, b.source) || ordered(a.id, b.id));
  const parents = rows.map((_, i) => i);
  function root(i) { while (parents[i] !== i) { parents[i] = parents[parents[i]]; i = parents[i]; } return i; }
  function union(a, b) {
    const x = root(a), y = root(b);
    if (x === y) return false;
    parents[Math.max(x, y)] = Math.min(x, y); return true;
  }
  const joiningEdges = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const reasons = relations(rows[i], rows[j], true);
      if (reasons.length && union(i, j)) joiningEdges.push({ a: rows[i].id, b: rows[j].id, reasons });
    }
  }
  const components = new Map();
  for (let i = 0; i < rows.length; i++) {
    const key = root(i);
    if (!components.has(key)) components.set(key, []);
    components.get(key).push(rows[i]);
  }
  const groups = [...components.values()].map(members => {
    const endpointIds = members.map(row => row.id);
    const directExposures = [];
    for (const row of members) for (const prior of exposed) {
      const reasons = relations(row, prior, false);
      if (reasons.length) directExposures.push({ endpointId: row.id, source: prior.source,
        exposedId: prior.id, reasons });
    }
    return { id: hash(canonical(endpointIds)), endpointIds,
      namedFamilies: [...new Set(members.map(row => row.namedFamily))].sort(ordered),
      exposed: directExposures.length > 0, directExposures };
  }).sort((a, b) => ordered(a.endpointIds[0], b.endpointIds[0]));
  // The authenticated manifest already carries full opening identities; this
  // map records the complete assignment without duplicating those records.
  const endpointRows = rows.map(row => ({ id: row.id,
    groupId: groups.find(group => group.endpointIds.includes(row.id)).id }));
  return { endpoints: endpointRows, joiningEdges, groups,
    counts: { endpoints: rows.length, components: groups.length,
      largestComponent: Math.max(...groups.map(group => group.endpointIds.length)),
      directlyExposedEndpoints: new Set(groups.flatMap(group => group.directExposures.map(row => row.endpointId))).size,
      endpointsInExposedComponents: groups.filter(group => group.exposed).reduce((sum, group) => sum + group.endpointIds.length, 0),
      componentsWithoutKnownExposure: groups.filter(group => !group.exposed).length },
    independenceEstablished: false, effectiveSampleSize: null };
}
function currentMap() {
  const M = require('./ai-match-openings-v2');
  const paths = ['test/ai-match-openings.js', 'eval/corpus/sources/openings-v1.tsv'];
  const inputs = paths.map(filename => {
    const bytes = fs.readFileSync(path.join(ROOT, filename));
    const expected = M.manifest.selection.exclusions.find(row => row.path === filename);
    const sha256 = hash(bytes);
    if (!expected || expected.fileSha256 !== sha256) throw new Error('exposure source changed: ' + filename);
    return { path: filename, bytes, sha256 };
  });
  const prior = new Module(path.join(ROOT, paths[0]), module);
  prior.filename = path.join(ROOT, paths[0]); prior.paths = module.paths;
  prior._compile(inputs[0].bytes.toString('utf8'), prior.filename);
  const lines = inputs[1].bytes.toString('utf8').trimEnd().split('\n');
  if (lines.shift() !== 'eco\tname\tpgn') throw new Error('unexpected exposure TSV header');
  const exposedSources = [
    { id: 'formal-match-v1', openings: prior.exports.map((row, i) => ({ id: String(i), pgn: row[1] })) },
    { id: 'eval-corpus-v1', openings: lines.map((line, i) => {
      const cells = line.split('\t');
      if (cells.length !== 3) throw new Error('invalid exposure TSV row');
      return { id: String(i), pgn: cells[2] };
    }) }
  ];
  const map = buildMap(M.openings, exposedSources);
  return { schema: 'chessy.match-family-map.v1', disposition: 'prospective-audit-only',
    manifestSha256: M.sha256, implementationSha256: hash(fs.readFileSync(__filename)),
    helpers: ['test/ai-match-opening-utils-v2.js', 'test/ai-match-holdout-audit.js', 'assets/engine.js']
      .map(filename => ({ path: filename, sha256: hash(fs.readFileSync(path.join(ROOT, filename))) })),
    exposureSources: inputs.map(({ path: filename, sha256 }) => ({ path: filename, sha256 })),
    grouping: 'connected-components-of-endpoint-structural-named-or-complete-line-prefix-v1',
    exposure: 'any-direct-known-exposure-propagates-to-whole-component-v1',
    mapSha256: hash(canonical(map) + '\n'), map,
    limitations: ['Connected components encode declared dependencies, not independent experimental units.',
      'No-known-exposure is relative to the two authenticated historical sources, not all model training or later development data.',
      'This map does not select or remove endpoints from the frozen diagnostic schedule.',
      'Formal admission remains unavailable; no candidate outcomes are consumed.'] };
}
function checkStoredMap(filename = OUTPUT) {
  const retained = fs.readFileSync(filename, 'utf8');
  if (retained !== JSON.stringify(currentMap(), null, 2) + '\n') {
    throw new Error('family-map.json missing or changed');
  }
}
function main(argv) {
  if (argv.length > 1 || (argv.length && argv[0] !== '--check')) throw new Error('usage: node test/ai-match-family-map.js [--check]');
  if (argv[0] === '--check') {
    checkStoredMap();
    console.log('prospective family map matches complete authenticated inputs');
  } else process.stdout.write(JSON.stringify(currentMap(), null, 2) + '\n');
}
if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = Object.freeze({ buildMap, currentMap, canonical, hash, checkStoredMap, main });
