/* Prospective holdout invariants. No candidate search is performed here. */
'use strict';
const assert = require('assert');
const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const U = require('./ai-match-opening-utils-v2');
const M = require('./ai-match-openings-v2');
const P = require('./ai-match-protocol-v2');
const Generator = require('./gen-ai-match-openings-v2');
const Chess = globalThis.Chess;
const root = path.join(__dirname, '..');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const exposed = new Set();
for (const row of require('./ai-match-openings')) {
  exposed.add(U.positionCluster(Chess.toFen(U.replayPgn(row[1]).state)));
}
const prior = fs.readFileSync(path.join(root,
  'eval/corpus/sources/openings-v1.tsv'), 'utf8').trim().split('\n').slice(1);
for (const row of prior) {
  exposed.add(U.positionCluster(Chess.toFen(U.replayPgn(row.split('\t')[2]).state)));
}
assert.equal(M.openings.length, 400);
assert.equal(hash(fs.readFileSync(M.path)), P.OPENINGS_MANIFEST_SHA256);
assert.equal(M.manifest.source.license, 'CC0-1.0');
assert.equal(M.manifest.source.commit, '4b8622759e7ae6f93f011cc6c83a3823401ab45e');
assert(M.manifest.source.licenseEvidence.some(x => x.path === 'COPYING.txt' &&
  /^[a-f0-9]{64}$/.test(x.sha256)));
assert(M.manifest.source.licenseEvidence.some(x => x.path === 'README.md'));
for (const record of M.manifest.selection.exclusions) {
  assert.equal(hash(fs.readFileSync(path.join(root, record.path))), record.fileSha256);
}
const groups = new Set(), ids = new Set(), strata = new Map();
const receipt = [];
for (const [index, row] of M.openings.entries()) {
  assert.equal(row.index, index);
  assert.equal(row.id, row.eco);
  assert(!ids.has(row.id)); ids.add(row.id);
  assert.equal(row.license, 'CC0-1.0');
  const replay = U.replayPgn(row.pgn, row.id);
  assert.equal(Chess.toFen(replay.state), row.fen, row.id + ' FEN');
  assert.equal(replay.uci, row.uci, row.id + ' UCI');
  assert.equal(replay.plies, row.plies);
  assert(row.plies >= 6 && row.plies <= 20);
  assert(!Chess.gameStatus(replay.state).over);
  const key = Chess.positionKey(Chess.parseFen(row.fen));
  assert.equal(key, row.positionKey);
  const group = U.positionCluster(row.fen);
  assert(!groups.has(group), row.id + ' duplicate/mirror');
  assert(!exposed.has(group), row.id + ' previously exposed endpoint');
  groups.add(group);
  assert.equal(hash(group), row.equivalenceGroupSha256);
  assert.equal(U.colourRankMirror(U.colourRankMirror(key)), key);
  assert.equal(U.positionCluster(U.colourRankMirror(key) + ' 0 1'), group);
  assert.equal(hash(row.eco + '\t' + row.name + '\t' + row.pgn), row.sourceRowSha256);
  const source = M.manifest.source.files.find(x => x.path === row.sourceFile);
  assert(source && source.sha256 === row.sourceFileSha256);
  assert(Number.isSafeInteger(row.sourceLine) && row.sourceLine >= 2 &&
    row.sourceLine <= source.rows + 1);
  const stratum = row.eco.slice(0, 2);
  strata.set(stratum, (strata.get(stratum) || 0) + 1);
  receipt.push(row.sourceFile + ':' + row.sourceLine + '\t' +
    row.rowRankSha256 + '\t' + row.eco + '\t' + row.positionKey + '\n');
}
assert.equal(groups.size, 400);
assert.equal(strata.size, 50);
for (const count of strata.values()) assert.equal(count, 8);
assert.equal(hash(receipt.join('')), M.manifest.selection.selectionReceiptSha256);
assert.throws(() => U.replayPgn('e4 e5 e4'), /matched 0/);
const ep = U.replayPgn('e4').state;
assert.equal(U.positionCluster(Chess.toFen(ep)),
  U.positionCluster(Chess.toFen(ep).replace(' e3 ', ' - ')));
assert(Object.isFrozen(M.manifest) && Object.isFrozen(M.openings[0]));
assert.throws(() => { M.openings[0].fen = 'invalid'; }, TypeError);

// A source checkout can hide modified tracked bytes with assume-unchanged.
// The freezer must consume the authenticated commit blob, not those bytes.
const fixtureRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'opening-v2-source-'));
function fixtureGit(args, encoding) {
  return cp.execFileSync('git', args, {
    cwd: fixtureRepo,
    encoding: encoding === undefined ? 'utf8' : encoding
  });
}
try {
  fixtureGit(['init', '--quiet']);
  fixtureGit(['config', 'user.name', 'Chessy test']);
  fixtureGit(['config', 'user.email', 'chessy-test@example.invalid']);
  fs.writeFileSync(path.join(fixtureRepo, 'source.txt'), 'authenticated\n');
  fixtureGit(['add', 'source.txt']);
  fixtureGit(['commit', '--quiet', '-m', 'source fixture']);
  const commit = fixtureGit(['rev-parse', 'HEAD']).trim();
  const sourceBlob = fixtureGit(['rev-parse', 'HEAD:source.txt']).trim();
  const replacementBlob = cp.execFileSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: fixtureRepo, encoding: 'utf8', input: 'replacement object\n'
  }).trim();
  fixtureGit(['replace', sourceBlob, replacementBlob]);
  fixtureGit(['update-index', '--assume-unchanged', 'source.txt']);
  fs.writeFileSync(path.join(fixtureRepo, 'source.txt'), 'hidden mutation\n');
  assert.equal(fixtureGit(['status', '--porcelain']).trim(), '');
  assert.equal(fixtureGit(['cat-file', 'blob', commit + ':source.txt']),
    'replacement object\n');
  const pinned = Generator.readPinnedFiles(fixtureRepo, commit, ['source.txt']);
  assert.equal(pinned.get('source.txt').toString('utf8'), 'authenticated\n');
  assert.notEqual(pinned.get('source.txt').toString('utf8'),
    fs.readFileSync(path.join(fixtureRepo, 'source.txt'), 'utf8'));
  assert.throws(() => Generator.readPinnedFiles(fixtureRepo, commit,
    ['source.txt', 'source.txt']), /duplicate pinned source path/);
} finally {
  fs.rmSync(fixtureRepo, { recursive: true, force: true });
}
console.log('400/400 prospective openings: legal, unique, mirror-grouped, unexposed endpoints; 50 strata x 8 openings');
