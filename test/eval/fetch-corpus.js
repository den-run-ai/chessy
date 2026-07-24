/*
 * eval-v1 corpus FETCHER (E1, ONLINE) — run with: node test/eval/fetch-corpus.js
 *
 * The shipped Chessy PWA is offline; the EVAL HARNESS and CI are not. This tool
 * runs online (manually / nightly) and commits a compact, FROZEN, license-clean
 * RAW SAMPLE of real public-domain (CC0) chess data under eval/corpus/sources/.
 * The deterministic, offline generator (test/eval/gen-corpus.js) then DERIVES
 * the corpus from those committed sources plus engine-generated fixtures — so
 * PR CI reproduces the corpus with no network.
 *
 * Sources (both CC0):
 *   - Lichess Open Database puzzles (database.lichess.org, CC0): streamed,
 *     stratified into 5 puzzle-difficulty bands. We commit only a small sample,
 *     never the multi-million-row dump.
 *   - lichess-org/chess-openings (CC0): ECO/name/pgn opening classification.
 *
 * Network note: Node's https bypasses the environment proxy, so we shell out to
 * `curl` (which honours HTTPS_PROXY + the CA bundle) for every fetch.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawn } = require('child_process');

const OUT_DIR = path.join(__dirname, '..', '..', 'eval', 'corpus', 'sources');
const PUZZLE_URL = 'https://database.lichess.org/lichess_db_puzzle.csv.zst';
const OPENINGS_BASE = 'https://raw.githubusercontent.com/lichess-org/chess-openings/master';
const OPENING_VOLUMES = ['a', 'b', 'c', 'd', 'e'];

const RATING_BANDS = [
  ['<1000', 0, 999], ['1000-1399', 1000, 1399], ['1400-1799', 1400, 1799],
  ['1800-2199', 1800, 2199], ['2200+', 2200, Infinity]
];
const PER_BAND = 8;            // committed puzzles per band → 40 total
const MAX_SCAN = 60000;        // rows to stream before giving up filling bands
const PER_VOLUME = 8;          // committed openings per ECO volume → up to 40
const OPENING_MIN_PLIES = 6, OPENING_MAX_PLIES = 12;

function sha256(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }

// --- curl helpers ----------------------------------------------------------
function curlText(url) {
  return new Promise((resolve, reject) => {
    const c = spawn('curl', ['-sS', '--fail', '--max-time', '120', url]);
    const out = [], err = [];
    c.stdout.on('data', d => out.push(d));
    c.stderr.on('data', d => err.push(d));
    c.on('close', code => code === 0 ? resolve(Buffer.concat(out).toString('utf8'))
      : reject(new Error('curl ' + url + ' exited ' + code + ': ' + Buffer.concat(err))));
  });
}

// Stream the zstd puzzle dump through curl, strip the leading skippable frame
// (Node's zstd decoder rejects it), decompress, and yield CSV lines until the
// bands are full or MAX_SCAN is reached — then kill curl (only the prefix
// transfers).
function streamPuzzles(onRow) {
  return new Promise((resolve, reject) => {
    const c = spawn('curl', ['-sS', '--max-time', '180', PUZZLE_URL]);
    const dec = zlib.createZstdDecompress();
    let headed = false, headBuf = Buffer.alloc(0), text = '', rows = 0, stopped = false;
    const stop = () => { if (stopped) return; stopped = true; try { c.kill('SIGKILL'); } catch (e) {} dec.destroy(); resolve(rows); };

    c.stdout.on('data', chunk => {
      if (stopped) return;
      if (!headed) {
        headBuf = Buffer.concat([headBuf, chunk]);
        if (headBuf.length < 12) return;
        let start = 0;
        if (headBuf[0] === 0x50 && headBuf[1] === 0x2a && headBuf[2] === 0x4d && (headBuf[3] & 0xf0) === 0x10) {
          start = 8 + headBuf.readUInt32LE(4); // magic(4)+size(4)+content
        }
        headed = true;
        dec.write(headBuf.slice(start));
        return;
      }
      dec.write(chunk);
    });
    c.on('close', () => { if (!stopped) dec.end(); });
    c.stderr.on('data', () => {});
    dec.on('data', chunk => {
      if (stopped) return;
      text += chunk.toString('utf8');
      let i;
      while ((i = text.indexOf('\n')) >= 0) {
        const line = text.slice(0, i); text = text.slice(i + 1);
        rows++;
        if (rows > MAX_SCAN) { stop(); return; }
        if (onRow(line, rows) === 'STOP') { stop(); return; }
      }
    });
    dec.on('error', e => { if (!stopped) { stopped = true; reject(e); } });
  });
}

// --- CSV (RFC-4180-lite: puzzle rows have no quoted commas) ----------------
function splitCsv(line) { return line.split(','); }

async function fetchPuzzles() {
  const header = 'PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags';
  const bands = new Map(RATING_BANDS.map(b => [b[0], []]));
  let headerSeen = false;

  await streamPuzzles((line, rowNum) => {
    if (rowNum === 1) { headerSeen = line.startsWith('PuzzleId'); return; }
    if (!line) return;
    const f = splitCsv(line);
    if (f.length < 9) return;
    const rating = Number(f[3]);
    if (!Number.isFinite(rating)) return;
    // A clean, solvable-labelled puzzle: at least a setup move + a key move.
    if (f[2].split(' ').length < 2) return;
    const band = RATING_BANDS.find(b => rating >= b[1] && rating <= b[2]);
    if (!band) return;
    const bucket = bands.get(band[0]);
    if (bucket.length < PER_BAND) bucket.push(line);
    // Done once every band is full.
    if ([...bands.values()].every(v => v.length >= PER_BAND)) return 'STOP';
  });

  if (!headerSeen) throw new Error('puzzle stream: header row not seen');
  // Abort rather than publish an underfilled stratum: writing a partial sample
  // while PROVENANCE claims "8 per band" would be false metadata, and the
  // generator (which accepts any total ≥ 20) would silently lose a difficulty
  // band. Raise MAX_SCAN and re-run if a band is genuinely sparse.
  const short = RATING_BANDS.filter(([name]) => bands.get(name).length < PER_BAND)
    .map(([name]) => name + ' (' + bands.get(name).length + '/' + PER_BAND + ')');
  if (short.length) {
    throw new Error('underfilled rating band(s) within MAX_SCAN=' + MAX_SCAN + ': ' + short.join(', ') +
      ' — raise MAX_SCAN and re-run');
  }
  const selected = [];
  for (const [name] of RATING_BANDS) {
    const rows = bands.get(name).slice().sort(); // deterministic by PuzzleId prefix
    selected.push(...rows.slice(0, PER_BAND));
  }
  const csv = header + '\n' + selected.join('\n') + '\n';
  fs.writeFileSync(path.join(OUT_DIR, 'lichess-puzzles-v1.csv'), csv);
  return { count: selected.length, sha256: sha256(csv), bands: RATING_BANDS.map(b => b[0]) };
}

function plies(pgn) {
  return pgn.replace(/\d+\.(\.\.)?/g, ' ').trim().split(/\s+/).filter(Boolean).length;
}

async function fetchOpenings() {
  const rows = ['eco\tname\tpgn'];
  const meta = {};
  for (const vol of OPENING_VOLUMES) {
    const tsv = await curlText(OPENINGS_BASE + '/' + vol + '.tsv');
    const lines = tsv.split('\n').slice(1).filter(Boolean).map(l => l.split('\t'));
    const eligible = lines.filter(c => c.length >= 3 && plies(c[2]) >= OPENING_MIN_PLIES && plies(c[2]) <= OPENING_MAX_PLIES);
    // Deterministic even stride across the eligible set of this volume.
    const step = Math.max(1, Math.floor(eligible.length / PER_VOLUME));
    const pick = [];
    for (let i = 0; i < eligible.length && pick.length < PER_VOLUME; i += step) pick.push(eligible[i]);
    for (const c of pick) rows.push(c[0] + '\t' + c[1] + '\t' + c[2]);
    meta[vol] = { eligible: eligible.length, picked: pick.length };
  }
  const tsv = rows.join('\n') + '\n';
  fs.writeFileSync(path.join(OUT_DIR, 'openings-v1.tsv'), tsv);
  return { count: rows.length - 1, sha256: sha256(tsv), volumes: meta };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const retrieval_date = new Date().toISOString().slice(0, 10);

  // Dump metadata (Last-Modified) for provenance.
  let dumpLastModified = null;
  try {
    const head = await new Promise((resolve, reject) => {
      const c = spawn('curl', ['-sSI', '--max-time', '30', PUZZLE_URL]);
      const out = []; c.stdout.on('data', d => out.push(d));
      c.on('close', () => resolve(Buffer.concat(out).toString('utf8')));
      c.on('error', reject);
    });
    const m = head.match(/last-modified:\s*(.+)/i);
    if (m) dumpLastModified = m[1].trim();
  } catch (e) { /* provenance best-effort */ }

  console.log('fetching CC0 Lichess puzzles (streamed, stratified)…');
  const puzzles = await fetchPuzzles();
  console.log('  committed ' + puzzles.count + ' puzzles across ' + puzzles.bands.length + ' bands');

  console.log('fetching CC0 lichess chess-openings…');
  const openings = await fetchOpenings();
  console.log('  committed ' + openings.count + ' openings');

  const provenance = {
    retrieval_date: retrieval_date,
    sources: {
      'lichess-puzzles-v1.csv': {
        source_url: PUZZLE_URL, license: 'CC0-1.0',
        dump_last_modified: dumpLastModified,
        selection: PER_BAND + ' per rating band (' + puzzles.bands.join(', ') + '), sorted by PuzzleId',
        count: puzzles.count, sha256: puzzles.sha256
      },
      'openings-v1.tsv': {
        source_url: OPENINGS_BASE, license: 'CC0-1.0',
        selection: PER_VOLUME + ' per ECO volume, ' + OPENING_MIN_PLIES + '-' + OPENING_MAX_PLIES + ' plies, even stride',
        count: openings.count, sha256: openings.sha256, volumes: openings.volumes
      }
    },
    note: 'Frozen raw CC0 sample. Regenerate with test/eval/fetch-corpus.js (online); the corpus is derived offline by test/eval/gen-corpus.js.'
  };
  fs.writeFileSync(path.join(OUT_DIR, 'PROVENANCE.json'), JSON.stringify(provenance, null, 2) + '\n');
  console.log('wrote eval/corpus/sources/{lichess-puzzles-v1.csv, openings-v1.tsv, PROVENANCE.json}');
  console.log('next: node test/eval/gen-corpus.js  (offline, deterministic)');
}

main().catch(e => { console.error('fetch failed:', e.message); process.exit(1); });
