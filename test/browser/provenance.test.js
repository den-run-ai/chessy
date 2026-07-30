/*
 * Master incident provenance: a live Play search survives local-save reload,
 * archive parking/commit, backup export and restore with enough evidence to
 * identify the release, budget, completed/attempted draft and stop reason.
 */
'use strict';
const fs = require('fs');
require('./helper').run('provenance', async function (t) {
  const page = t.page, check = t.check;

  // Easy's 10k-node budget keeps the WASM-only integration test quick.
  await t.newGame({ mode: 'ai-w', difficulty: '1' });
  await page.waitForFunction(function () {
    const raw = localStorage.getItem('chessy-game-v1');
    if (!raw) return false;
    const saved = JSON.parse(raw);
    return saved.history && saved.history[0] && saved.history[0].ai;
  }, null, { timeout: 10000 });

  const live = await page.evaluate(function () {
    const saved = JSON.parse(localStorage.getItem('chessy-game-v1'));
    return {
      release: window.CHESSY_RELEASE,
      startedRelease: saved.startedRelease,
      entry: saved.history[0],
      ai: saved.history[0].ai
    };
  });
  const ai = live.ai;
  check(live.startedRelease === live.release && ai.release === live.release,
    'live save records game-start and per-move release identifiers');
  check(ai.depth >= 1 && ai.attemptedDepth === ai.depth + 1 &&
      ai.maxDepth === 30 && ai.stopReason === 'node-limit',
    'live telemetry distinguishes completed depth, attempted depth and stop reason');
  check(Number.isInteger(ai.nodes) && ai.nodes > 0 &&
      Number.isInteger(ai.qnodes) && Number.isFinite(ai.score) &&
      ai.scorePov === 'white',
    'live telemetry records node counts and an explicit score POV');
  check(ai.timeMs === 5000 && ai.nodeLimit === 10000 &&
      ai.nodes === ai.nodeLimit && ai.quiesce === true &&
      ai.seed === null && ai.randomize === null &&
      ai.engine === 'wasm' && ai.engineFallback === null,
    'live telemetry records the effective Play search config');
  check(Number.isFinite(ai.elapsedMs) && Number.isFinite(ai.searchMs) &&
      ai.elapsedMs >= ai.searchMs && ai.source === 'worker' &&
      ai.fallbackReason === null,
    'live telemetry separates end-to-end and engine search elapsed time');
  check(Array.isArray(ai.pvUci) && ai.pvUci.length === 0 &&
      ai.pvSource === null &&
      !Object.prototype.hasOwnProperty.call(ai, 'rootOrderUci'),
    'Play telemetry does not invent evidence absent from the raw WASM result');

  // Loading a save used to collapse AI evidence back to depth/quiesce/ms.
  // Reload this in-progress game and require every forensic field to survive.
  await page.reload();
  await page.waitForSelector('#board .square');
  const reloadedAi = await page.evaluate(function () {
    return JSON.parse(localStorage.getItem('chessy-game-v1')).history[0].ai;
  });
  check(JSON.stringify(reloadedAi) === JSON.stringify(ai),
    'local-save replay preserves the complete AI telemetry object');

  // Archive the exact one-move state as a resignation. This uses the normal
  // archive path (including its durability queue) without playing a long game.
  await page.evaluate(function (fixture) {
    let s = Chess.newGameState();
    const legal = Chess.legalMoves(s);
    const wanted = fixture.entry.move;
    const move = legal.find(function (m) {
      return m.from === wanted.from && m.to === wanted.to &&
        (m.promotion || null) === (wanted.promotion || null);
    });
    s = Chess.playMove(s, move);
    s.history[0].ai = fixture.ai;
    return ChessyArchive.record(
      s,
      { mode: 'ai-w', difficulty: '1', timeControl: 'none' },
      { over: true, result: '1-0', reason: 'resignation' },
      'telemetry-roundtrip',
      { endedAt: 1234, startedRelease: fixture.startedRelease });
  }, live);

  const archived = await page.evaluate(function () {
    return CoachStore.getGame('telemetry-roundtrip');
  });
  check(archived.startedRelease === live.release &&
      archived.ai.length === 1 && archived.ai[0].release === live.release,
    'archive record keeps release and per-ply AI evidence');
  check(archived.ai[0].nodes === ai.nodes &&
      archived.ai[0].attemptedDepth === ai.attemptedDepth &&
      archived.ai[0].engine === 'wasm' &&
      archived.ai[0].pvUci.length === 0 &&
      !Object.prototype.hasOwnProperty.call(archived.ai[0], 'rootOrderUci'),
    'archive record keeps counters, attempted draft and honest WASM provenance');

  // Reload returns to Play, where the data controls are intentionally hidden.
  // Exercise the user-visible Review path before requesting the backup.
  await page.click('#tabReview');
  await page.waitForSelector('#gameListWrap:not([hidden])');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#backupBtn')
  ]);
  const backup = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
  const backed = backup.stores.games.find(function (g) {
    return g.id === 'telemetry-roundtrip';
  });
  check(backup.release === live.release,
    'backup envelope identifies the exporting release');
  check(backed && backed.startedRelease === live.release &&
      backed.ai[0].stopReason === ai.stopReason &&
      backed.ai[0].searchMs === ai.searchMs &&
      backed.ai[0].scorePov === 'white',
    'backup export retains the archived search evidence');

  // The optional additive fields do not invalidate a v1 backup from before
  // telemetry. Conversely, malformed telemetry is rejected before a restore.
  const compatibility = await page.evaluate(function (data) {
    const legacy = JSON.parse(JSON.stringify(data));
    delete legacy.release;
    legacy.stores.games.forEach(function (g) {
      delete g.startedRelease;
      if (g.id === 'telemetry-roundtrip') {
        g.ai = [{ depth: 1, quiesce: false, ms: 12 }];
      } else {
        delete g.ai;
      }
    });
    const malformed = JSON.parse(JSON.stringify(data));
    const row = malformed.stores.games.find(function (g) {
      return g.id === 'telemetry-roundtrip';
    });
    row.ai = [{}]; // wrong/empty evidence must not be silently trusted
    const wrongRoot = JSON.parse(JSON.stringify(data));
    const wrongRootRow = wrongRoot.stores.games.find(function (g) {
      return g.id === 'telemetry-roundtrip';
    });
    wrongRootRow.ai[0].rootOrderUci = [];
    return {
      legacy: CoachStore.validateBackup(legacy),
      malformed: CoachStore.validateBackup(malformed),
      wrongRoot: CoachStore.validateBackup(wrongRoot)
    };
  }, backup);
  check(compatibility.legacy === null,
    'pre-telemetry version-1 backups remain valid');
  check(typeof compatibility.malformed === 'string' &&
      compatibility.malformed.includes('AI telemetry'),
    'malformed optional AI telemetry is rejected before restore');
  check(typeof compatibility.wrongRoot === 'string' &&
      compatibility.wrongRoot.includes('root order') &&
      compatibility.wrongRoot.includes('position'),
    'restore rejects an incomplete root order for its recorded position');

  await page.evaluate(function (data) {
    return CoachStore.restoreAll(data);
  }, backup);
  const restored = await page.evaluate(function () {
    return CoachStore.getGame('telemetry-roundtrip');
  });
  check(restored && restored.ai[0].nodes === ai.nodes &&
      restored.ai[0].release === live.release,
    'backup restore round-trips search telemetry unchanged');

  // Review exports the durable archive shape, not Play's live history. The
  // restored record must therefore offer that retained search evidence in the
  // explicit debug PGN without contaminating the ordinary score.
  await page.evaluate(function () {
    return CoachReview.openArchivedGame('telemetry-roundtrip');
  });
  await page.waitForSelector('#reviewFlow:not([hidden])');
  const [cleanDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#reviewExportPgn')
  ]);
  const cleanPgn = fs.readFileSync(await cleanDownload.path(), 'utf8');
  check(!cleanPgn.includes('{engine') && !cleanPgn.includes('{before:'),
    'restored telemetry does not change the ordinary Review PGN');
  const [reviewDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#reviewExportPgnLog')
  ]);
  const reviewPgn = fs.readFileSync(await reviewDownload.path(), 'utf8');
  const firstSanPattern = backed.sans[0]
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const reviewEvidence = {
    filename: /-debug\.pgn$/.test(reviewDownload.suggestedFilename()),
    aligned: new RegExp(firstSanPattern + '\\s+\\{engine depth ' + ai.depth)
      .test(reviewPgn),
    nodes: reviewPgn.includes(ai.nodes + ' nodes'),
    stop: reviewPgn.includes('stop ' + ai.stopReason),
    release: reviewPgn.includes('release ' + ai.release),
    engine: reviewPgn.includes('engine wasm'),
    source: reviewPgn.includes('source worker')
  };
  check(Object.keys(reviewEvidence).every(function (key) {
    return reviewEvidence[key];
  }),
    'Review debug PGN exports restored per-ply search provenance');
});
