/*
 * Deterministically reproduce eval/match-v2/openings.json from the pinned
 * lichess-org/chess-openings checkout documented in PROVENANCE.md.
 *
 * Usage:
 *   node test/gen-ai-match-openings-v2.js --source-dir /path/to/chess-openings
 *   node test/gen-ai-match-openings-v2.js --check --source-dir /path/to/chess-openings
 *
 * The selector intentionally uses no random seed. It excludes positions
 * exposed by v1, selects eight hash-ranked ECO codes from each A0-E9 stratum,
 * and chooses one hash-ranked legal line per selected code.
 */
'use strict';

const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
require('../assets/engine.js');
const Chess = globalThis.Chess;
const OpeningUtils = require('./ai-match-opening-utils-v2');
const V1_OPENINGS = require('./ai-match-openings');
const V1_PROTOCOL = require('./ai-match-protocol');

const ROOT = path.join(__dirname, '..');
const OUTPUT = path.join(ROOT, 'eval', 'match-v2', 'openings.json');
const SOURCE_COMMIT = '4b8622759e7ae6f93f011cc6c83a3823401ab45e';
const SOURCE_TREE = '8878c260c6f474447ef3a0401d3211468dc92c57';
const SOURCE_REPOSITORY = 'https://github.com/lichess-org/chess-openings';
const SOURCE_FILES = ['a.tsv', 'b.tsv', 'c.tsv', 'd.tsv', 'e.tsv'];
const SOURCE_EVIDENCE_FILES = ['README.md', 'COPYING.txt', 'bin/gen.py'];
const MIN_PLIES = 6;
const MAX_PLIES = 20;
const SELECTOR_ID = 'chessy-openings-v2-selection-v1';
const EVAL_V1_PATH = path.join(ROOT, 'eval', 'corpus', 'sources',
  'openings-v1.tsv');

function usage(message) {
  if (message) console.error(message);
  console.error('usage: node test/gen-ai-match-openings-v2.js [--check] ' +
    '--source-dir /path/to/chess-openings');
  process.exit(2);
}
let SOURCE_DIR = null;
let CHECK = false;
function configure(argv) {
  const known = new Set(['--check', '--source-dir']);
  for (let i = 0; i < argv.length; i++) {
    if (!known.has(argv[i])) usage('unknown option ' + argv[i]);
    if (argv[i] === '--source-dir') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
        usage('--source-dir requires a value');
      }
      i++;
    }
  }
  if (argv.filter(function (x) { return x === '--check'; }).length > 1 ||
      argv.filter(function (x) { return x === '--source-dir'; }).length > 1) {
    usage('options may be supplied at most once');
  }
  const sourceIndex = argv.indexOf('--source-dir');
  if (sourceIndex < 0) usage('--source-dir is required');
  SOURCE_DIR = path.resolve(argv[sourceIndex + 1]);
  CHECK = argv.includes('--check');
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function bytewise(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function gitOutput(args) {
  try {
    return cp.execFileSync('git', [
      '--no-replace-objects', '-C', SOURCE_DIR
    ].concat(args), {
      encoding: 'utf8'
    }).trim();
  } catch (error) {
    throw new Error('cannot inspect source checkout: ' + error.message);
  }
}

function gitBlob(file) {
  const line = gitOutput(['ls-tree', SOURCE_COMMIT, '--', file]);
  const match = line.match(/^\d+ blob ([0-9a-f]{40})\t/);
  if (!match) throw new Error('cannot resolve source blob for ' + file);
  return match[1];
}

// Consume bytes from the authenticated commit object, never from the source
// checkout's filesystem. In particular, `git update-index --assume-unchanged`
// can hide a modified worktree file from status; it cannot alter a Git blob.
function readGitBlob(repository, commit, file) {
  try {
    return cp.execFileSync('git', [
      '--no-replace-objects', '-C', repository,
      'cat-file', 'blob', commit + ':' + file
    ], { encoding: null, maxBuffer: 1 << 27 });
  } catch (error) {
    throw new Error('cannot read pinned source blob ' + file + ': ' +
      error.message);
  }
}

function readPinnedFiles(repository, commit, files) {
  const result = new Map();
  for (const file of files) {
    if (result.has(file)) throw new Error('duplicate pinned source path ' + file);
    result.set(file, readGitBlob(repository, commit, file));
  }
  return result;
}

function readRows(file, bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.includes('\r') || text.includes('\0')) {
    throw new Error(file + ': source must be LF UTF-8 without NUL bytes');
  }
  const lines = text.split('\n');
  if (lines.pop() !== '') {
    throw new Error(file + ': source must end in exactly one newline');
  }
  if (lines[0] !== 'eco\tname\tpgn') {
    throw new Error(file + ': unexpected TSV header');
  }
  const rows = [];
  for (let index = 1; index < lines.length; index++) {
    const columns = lines[index].split('\t');
    if (columns.length !== 3) {
      throw new Error(file + ':' + (index + 1) + ': expected three columns');
    }
    const eco = columns[0], name = columns[1], pgn = columns[2];
    if (!/^[A-E]\d\d$/.test(eco) || eco[0].toLowerCase() + '.tsv' !== file) {
      throw new Error(file + ':' + (index + 1) + ': invalid ECO ' + eco);
    }
    const replay = OpeningUtils.replayPgn(pgn, file + ':' + (index + 1));
    const fen = Chess.toFen(replay.state);
    const terminal = Chess.gameStatus(replay.state).over;
    const sourceTuple = eco + '\t' + name + '\t' + pgn;
    const rowRank = sha256(SELECTOR_ID + '\0row\0' + SOURCE_COMMIT + '\0' +
      file + '\0' + (index + 1) + '\0' + sourceTuple);
    rows.push({
      eco: eco,
      name: name,
      pgn: pgn,
      plies: replay.plies,
      uci: replay.uci,
      fen: fen,
      terminal: terminal,
      cluster: OpeningUtils.positionCluster(fen),
      sourceFile: file,
      sourceLine: index + 1,
      sourceRowSha256: sha256(sourceTuple),
      sourceTuple: sourceTuple,
      rowRank: rowRank
    });
  }
  return {
    bytes: bytes,
    rows: rows,
    provenance: {
      path: file,
      gitBlobSha1: gitBlob(file),
      sha256: sha256(bytes),
      bytes: bytes.length,
      rows: rows.length
    }
  };
}

function fileEvidence(file, bytes) {
  return {
    path: file,
    gitBlobSha1: gitBlob(file),
    sha256: sha256(bytes),
    bytes: bytes.length
  };
}

function exposedV1Clusters() {
  const clusters = new Set();
  for (let index = 0; index < V1_OPENINGS.length; index++) {
    const replay = OpeningUtils.replayPgn(V1_OPENINGS[index][1],
      'formal v1 opening ' + index);
    clusters.add(OpeningUtils.positionCluster(Chess.toFen(replay.state)));
  }
  const evalBytes = fs.readFileSync(EVAL_V1_PATH);
  const lines = evalBytes.toString('utf8').trimEnd().split('\n');
  if (lines.shift() !== 'eco\tname\tpgn') {
    throw new Error('unexpected eval-v1 opening TSV header');
  }
  for (let index = 0; index < lines.length; index++) {
    const columns = lines[index].split('\t');
    if (columns.length !== 3) {
      throw new Error('eval-v1 opening TSV line ' + (index + 2) +
        ' does not have three columns');
    }
    const replay = OpeningUtils.replayPgn(columns[2],
      'eval v1 opening ' + (index + 2));
    clusters.add(OpeningUtils.positionCluster(Chess.toFen(replay.state)));
  }
  return {
    clusters: clusters,
    records: [
      {
        id: 'formal-match-openings-v1',
        path: 'test/ai-match-openings.js',
        manifestSha256: V1_PROTOCOL.OPENINGS_MANIFEST_SHA256,
        fileSha256: sha256(fs.readFileSync(path.join(ROOT,
          'test', 'ai-match-openings.js'))),
        endpoints: V1_OPENINGS.length
      },
      {
        id: 'eval-corpus-openings-v1',
        path: 'eval/corpus/sources/openings-v1.tsv',
        fileSha256: sha256(evalBytes),
        endpoints: lines.length
      }
    ]
  };
}

function generate() {
  const head = gitOutput(['rev-parse', '--verify', 'HEAD^{commit}']);
  if (head !== SOURCE_COMMIT) {
    throw new Error('source checkout must be exactly ' + SOURCE_COMMIT +
      ' (got ' + head + ')');
  }
  const tree = gitOutput(['rev-parse', '--verify', 'HEAD^{tree}']);
  if (tree !== SOURCE_TREE) {
    throw new Error('source tree must be exactly ' + SOURCE_TREE +
      ' (got ' + tree + ')');
  }
  const dirty = gitOutput(['status', '--porcelain', '--untracked-files=no']);
  if (dirty) throw new Error('source checkout has tracked modifications');

  const sourceBytes = readPinnedFiles(SOURCE_DIR, SOURCE_COMMIT,
    SOURCE_FILES.concat(SOURCE_EVIDENCE_FILES));
  const loaded = SOURCE_FILES.map(function (file) {
    return readRows(file, sourceBytes.get(file));
  });
  const exposed = exposedV1Clusters();
  const eligible = loaded.flatMap(function (item) { return item.rows; }).filter(
    function (row) {
      return !row.terminal && row.plies >= MIN_PLIES && row.plies <= MAX_PLIES &&
        !exposed.clusters.has(row.cluster);
    });

  // Collapse transpositions/mirrors before choosing one representative per
  // ECO code. The current source has no internal endpoint collision, but the
  // fail-closed rule is part of the frozen selector.
  const byCluster = new Map();
  for (const row of eligible) {
    const previous = byCluster.get(row.cluster);
    if (!previous || bytewise(row.rowRank, previous.rowRank) < 0 ||
        (row.rowRank === previous.rowRank &&
          (bytewise(row.sourceFile, previous.sourceFile) < 0 ||
           (row.sourceFile === previous.sourceFile &&
            row.sourceLine < previous.sourceLine)))) {
      byCluster.set(row.cluster, row);
    }
  }
  const byEco = new Map();
  for (const row of byCluster.values()) {
    const previous = byEco.get(row.eco);
    if (!previous || bytewise(row.rowRank, previous.rowRank) < 0) {
      byEco.set(row.eco, row);
    }
  }

  const choices = [];
  for (const volume of ['A', 'B', 'C', 'D', 'E']) {
    for (let decade = 0; decade < 10; decade++) {
      const stratum = volume + decade;
      const codes = Array.from(byEco.keys()).filter(function (eco) {
        return eco.startsWith(stratum);
      }).map(function (eco) {
        return {
          eco: eco,
          rank: sha256(SELECTOR_ID + '\0eco\0' + SOURCE_COMMIT + '\0' + eco),
          row: byEco.get(eco)
        };
      }).sort(function (a, b) {
        return bytewise(a.rank, b.rank) || bytewise(a.eco, b.eco);
      });
      if (codes.length < 8) {
        throw new Error('ECO stratum ' + stratum + ' has only ' + codes.length +
          ' eligible code representatives');
      }
      choices.push.apply(choices, codes.slice(0, 8));
    }
  }
  choices.sort(function (a, b) {
    return bytewise(a.eco, b.eco) || bytewise(a.row.sourceFile, b.row.sourceFile) ||
      a.row.sourceLine - b.row.sourceLine;
  });
  const fileByPath = new Map(loaded.map(function (item) {
    return [item.provenance.path, item.provenance];
  }));
  const selected = choices.map(function (choice, index) {
    const row = choice.row;
    const positionKey = Chess.positionKey(Chess.parseFen(row.fen));
    return {
      index: index,
      id: choice.eco,
      eco: choice.eco,
      family: row.name.split(':')[0],
      name: row.name,
      pgn: row.pgn,
      uci: row.uci,
      plies: row.plies,
      fen: row.fen,
      positionKey: positionKey,
      equivalenceGroupSha256: sha256(row.cluster),
      sourceId: 'lichess-chess-openings@' + SOURCE_COMMIT + ':' +
        row.sourceFile + ':' + row.sourceLine,
      sourceUrl: SOURCE_REPOSITORY + '/blob/' + SOURCE_COMMIT + '/' +
        row.sourceFile + '#L' + row.sourceLine,
      sourceFile: row.sourceFile,
      sourceFileSha256: fileByPath.get(row.sourceFile).sha256,
      sourceLine: row.sourceLine,
      sourceRowSha256: row.sourceRowSha256,
      rowRankSha256: row.rowRank,
      ecoRankSha256: choice.rank,
      license: 'CC0-1.0'
    };
  });
  const selectedClusters = new Set(choices.map(function (choice) {
    return choice.row.cluster;
  }));
  if (selected.length !== 400 || selectedClusters.size !== 400) {
    throw new Error('selector produced ' + selected.length + ' openings and ' +
      selectedClusters.size + ' independent clusters');
  }
  const receipt = selected.map(function (opening) {
    return opening.sourceFile + ':' + opening.sourceLine + '\t' +
      opening.rowRankSha256 + '\t' + opening.eco + '\t' +
      opening.positionKey + '\n';
  }).join('');

  return {
    schema: 'chessy-opening-manifest-v2',
    version: 'chessy-openings-v2-400-cc0',
    source: {
      dataset: 'lichess-org/chess-openings',
      sourceKind: 'curated-opening-lines',
      repository: SOURCE_REPOSITORY,
      commit: SOURCE_COMMIT,
      tree: SOURCE_TREE,
      commitTime: '2026-08-04T04:17:01+02:00',
      sourceGameIdentity: null,
      sourceGameIdentityReason: 'catalog rows are opening facts, not games',
      license: 'CC0-1.0',
      licenseName: 'CC0 1.0 Universal',
      licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
      licenseFile: 'COPYING.txt',
      licenseEvidence: SOURCE_EVIDENCE_FILES.map(function (file) {
        return fileEvidence(file, sourceBytes.get(file));
      }),
      files: loaded.map(function (item) { return item.provenance; })
    },
    selection: {
      algorithm: SELECTOR_ID,
      eligiblePlies: { minimum: MIN_PLIES, maximum: MAX_PLIES },
      exclusions: exposed.records,
      exposedEndpointClusters: exposed.clusters.size,
      eligibleRowsAfterExclusions: eligible.length,
      eligibleEquivalenceGroups: byCluster.size,
      eligibleEcoCodes: byEco.size,
      strata: 'A0 through E9; eight SHA-256-ranked ECO codes per stratum',
      rowRank: 'SHA256(algorithm NUL row NUL commit NUL path NUL line NUL exact TSV row)',
      ecoRank: 'SHA256(algorithm NUL eco NUL commit NUL ECO)',
      collisionRule: 'lowest-ranked row per legal-position/colour-rank-mirror group, then per ECO',
      selectionReceiptSha256: sha256(receipt),
      countsByVolume: { A: 80, B: 80, C: 80, D: 80, E: 80 },
      countsByStratum: 8
    },
    openings: selected
  };
}

function main(argv) {
  configure(argv);
  try {
    const rendered = JSON.stringify(generate(), null, 2) + '\n';
    if (CHECK) {
      const actual = fs.readFileSync(OUTPUT, 'utf8');
      if (actual !== rendered) {
        console.error('eval/match-v2/openings.json is stale for the pinned source');
        process.exit(1);
      }
      console.log('openings.json matches pinned source (' + sha256(rendered) + ')');
    } else {
      fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
      fs.writeFileSync(OUTPUT, rendered);
      console.log('wrote ' + path.relative(ROOT, OUTPUT) + ' (' +
        sha256(rendered) + ')');
    }
  } catch (error) {
    console.error('FAIL: ' + error.message);
    process.exit(1);
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = Object.freeze({
  readPinnedFiles: readPinnedFiles
});
