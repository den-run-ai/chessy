/*
 * Revision ordering across the three recovery sources (committed row, parked
 * durability-queue entry, live save). A monotonic `rev` — never wall-clock —
 * decides which copy of a game id is the latest finish, and the SAME rule holds
 * in park(), archiveGame() and the backup merge: a LOWER revision may never
 * replace an ending, replace metadata, overwrite a pending record, or trigger
 * derived-data pruning. Also the durable revision floor (a failed REV_KEY write
 * cannot make revisions go backward after reload) and the legacy (pre-rev)
 * boot-migration rule that preserves a same-id pending revision. SINGLE-TAB by
 * design (#44). */
'use strict';
const fs = require('fs');
require('./helper').run('revision-order', async function (t) {
  const page = t.page, check = t.check;

  // Clear the durable store and the recovery sources so the sections below are
  // independent.
  async function reset() {
    await page.evaluate(function () {
      localStorage.removeItem('chessy-pending-archive-v1');
      localStorage.removeItem('chessy-game-v1');
      localStorage.removeItem('chessy-archive-rev-v1'); // the persisted REV_KEY floor
      return new Promise(function (resolve) {
        const req = indexedDB.deleteDatabase('chessy-coach');
        req.onsuccess = req.onerror = req.onblocked = function () { resolve(); };
      });
    });
  }
  async function pending() {
    return page.evaluate(function () {
      return JSON.parse(localStorage.getItem('chessy-pending-archive-v1') || 'null');
    });
  }

  // ── (5) A lower-revision park() cannot replace a higher-revision same-id
  // pending entry. Suspend live commits so record() only PARKS, isolating the
  // queue guard: a rev-2 re-offer must not displace the rev-5 revision awaiting
  // recovery.
  await reset();
  await page.evaluate(function () {
    const mk = function (sans) { return { history: sans.map(function (s) { return { san: s }; }) }; };
    const cfg = { mode: 'pvp', difficulty: '3', timeControl: 'none' };
    const over = { over: true, result: '1-0', reason: 'checkmate' };
    ChessyArchive.setSuspended(true); // park-only, no commit
    localStorage.setItem('chessy-pending-archive-v1', JSON.stringify({
      'park-id': { w: 'w-hi', rec: { id: 'park-id', source: 'play', sans: ['d4', 'd5'],
        result: '1-0', reason: 'resignation', mode: 'pvp', difficulty: '2', timeControl: 'none',
        plies: 2, clocks: [null, null], createdAt: 100, rev: 5 } }
    }));
    // A stale lower-rev, DIFFERENT ending re-offered under the same id.
    ChessyArchive.record(mk(['e4', 'e5']), cfg, over, 'park-id', { endedAt: 200, rev: 2 });
    ChessyArchive.setSuspended(false);
  });
  const parkGuard = await pending();
  check(parkGuard && parkGuard['park-id'] && parkGuard['park-id'].rec.sans.join(',') === 'd4,d5' &&
    parkGuard['park-id'].rec.rev === 5,
    'a lower-revision park() cannot replace a higher-revision same-id pending entry');

  // ── (1) Pending B rev=2 COMMITS (with a lesson card), then a stale save A
  // rev=1 is boot-reoffered under the same id: archiveGame() compares rev BEFORE
  // any overwrite/prune, so B and B's cards survive the stale lower-rev write.
  await reset();
  const survived = await page.evaluate(function () {
    const mk = function (sans) { return { history: sans.map(function (s) { return { san: s }; }) }; };
    const cfg = { mode: 'pvp', difficulty: '3', timeControl: 'none' };
    const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
    // B (rev 2): the real revision, committed, with a card at ply 2.
    return ChessyArchive.record(mk(['f3', 'e5', 'g4', 'Qh4#']), cfg,
      { over: true, result: '0-1', reason: 'checkmate' }, 'commit-x', { endedAt: 9, rev: 2 })
      .then(function () {
        return CoachStore.addCard({ gameId: 'commit-x', ply: 2, cause: 't', due: 1, step: -1,
          attempts: [], fenBefore: fen });
      })
      .then(function () {
        // A (rev 1): a stale boot save of a DIFFERENT ending, applied last.
        return ChessyArchive.record(mk(['e4', 'e5']), cfg,
          { over: true, result: '1-0', reason: 'checkmate' }, 'commit-x', { endedAt: 5, rev: 1 });
      })
      .then(function () {
        return Promise.all([CoachStore.getGame('commit-x'), CoachStore.listCards()]);
      })
      .then(function (r) {
        return { sans: r[0] && r[0].sans.join(','), rev: r[0] && r[0].rev,
          cards: r[1].filter(function (c) { return c.gameId === 'commit-x'; }).length };
      });
  });
  check(survived.sans === 'f3,e5,g4,Qh4#' && survived.rev === 2,
    'a committed rev-2 ending survives a stale rev-1 boot re-offer (archiveGame compares rev)');
  check(survived.cards === 1,
    "the stale lower-rev write does not prune the newer record's cards");

  // ── (3) Failed counter persistence → reload → Undo/re-finish still produces a
  // HIGHER revision. REV_KEY was dropped at quota and holds a STALE low value,
  // but the live save carries the true high rev; nextRev() seeds its floor from
  // the save, so a fresh finish cannot regress below a rev already in use.
  await reset();
  // A genuine FINISHED save (fool's mate) that persisted rev 50, so the app
  // accepts it on boot and keeps it (a bogus save would be replaced by a fresh
  // game, wiping the rev). Injected on the app-less /blank page — the app saves
  // on pagehide, which would otherwise clobber an in-place mutation.
  await t.inject(function () {
    localStorage.setItem('chessy-archive-rev-v1', '4'); // stale/failed counter
    localStorage.setItem('chessy-game-v1', JSON.stringify({
      fen: 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3',
      history: [
        { move: { from: 53, to: 45, piece: 'wP', captured: null, promotion: null, ep: false, castle: null, double: false }, san: 'f3' },
        { move: { from: 12, to: 28, piece: 'bP', captured: null, promotion: null, ep: false, castle: null, double: true }, san: 'e5' },
        { move: { from: 54, to: 38, piece: 'wP', captured: null, promotion: null, ep: false, castle: null, double: true }, san: 'g4' },
        { move: { from: 3, to: 39, piece: 'bQ', captured: null, promotion: null, ep: false, castle: null, double: false }, san: 'Qh4#' }
      ],
      positions: {
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -': 1,
        'rnbqkbnr/pppppppp/8/8/8/5P2/PPPPP1PP/RNBQKBNR b KQkq -': 1,
        'rnbqkbnr/pppp1ppp/8/4p3/8/5P2/PPPPP1PP/RNBQKBNR w KQkq -': 1,
        'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq -': 1,
        'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq -': 1
      },
      mode: 'pvp', difficulty: '2', timeControl: 'none', clocks: null, timeForfeit: null,
      flipped: false, gameId: 'floor-x', endedAt: 40, rev: 50
    }));
  });
  const floorRev = await page.evaluate(function () {
    // The rev a re-finish (Undo → new ending) would stamp: strictly above 50,
    // NOT the stale REV_KEY's 4+1.
    return { first: ChessyArchive.nextRev(), second: ChessyArchive.nextRev() };
  });
  check(floorRev.first > 50 && floorRev.second > floorRev.first,
    'a dropped REV_KEY write cannot regress the revision after reload (floor seeded from the save)');

  // ── (4a) Legacy (pre-rev) boot, RECONCILE SUCCESS. Both A and B are revless.
  // Pending B is the revision; it reconciles first (migrated INTO the sequence
  // with a fresh rev), then a stale revless save A is boot-reoffered. B wins.
  await reset();
  const legacyOk = await page.evaluate(function () {
    const mk = function (sans) { return { history: sans.map(function (s) { return { san: s }; }) }; };
    const cfg = { mode: 'pvp', difficulty: '3', timeControl: 'none' };
    localStorage.setItem('chessy-pending-archive-v1', JSON.stringify({
      'legacy-x': { w: 'w-legacy', rec: { id: 'legacy-x', source: 'play', sans: ['d4', 'd5', 'Qd3'],
        result: '1-0', reason: 'checkmate', mode: 'pvp', difficulty: '2', timeControl: 'none',
        plies: 3, clocks: [null, null, null], createdAt: 20 } } // no rev — legacy
    }));
    return ChessyArchive.reconcilePending() // commits B, migrating it to a rev
      .then(function () {
        // Stale legacy save A re-offered (no opts.rev → revless): must NOT win.
        return ChessyArchive.record(mk(['e4', 'e5']), cfg,
          { over: true, result: '1-0', reason: 'checkmate' }, 'legacy-x', { endedAt: 5 });
      })
      .then(function () { return CoachStore.getGame('legacy-x'); })
      .then(function (g) { return { sans: g && g.sans.join(','), rev: g && g.rev }; });
  });
  check(legacyOk.sans === 'd4,d5,Qd3' && Number.isFinite(legacyOk.rev),
    'a reconciled revless pending revision is migrated to a rev and survives a stale revless re-offer');

  // ── (4b) Legacy boot, RECONCILE FAILURE. Pending B (revless) cannot commit;
  // boot re-offers a stale revless save A of a DIFFERENT ending. park() refuses
  // to overwrite B on the revless tie, so B stays parked and recoverable.
  await reset();
  const legacyFail = await page.evaluate(function () {
    const mk = function (sans) { return { history: sans.map(function (s) { return { san: s }; }) }; };
    const cfg = { mode: 'pvp', difficulty: '3', timeControl: 'none' };
    const real = CoachStore.archiveGame;
    CoachStore.archiveGame = function (rec) {
      if (rec.id === 'legacy-fail') return Promise.reject(new Error('quota'));
      return real.apply(this, arguments);
    };
    localStorage.setItem('chessy-pending-archive-v1', JSON.stringify({
      'legacy-fail': { w: 'w-lf', rec: { id: 'legacy-fail', source: 'play', sans: ['d4', 'd5', 'Qd3'],
        result: '1-0', reason: 'checkmate', mode: 'pvp', difficulty: '2', timeControl: 'none',
        plies: 3, clocks: [null, null, null], createdAt: 20 } } // no rev — legacy
    }));
    return ChessyArchive.reconcilePending().catch(function () { /* B's commit fails, stays parked */ })
      .then(function () {
        // Stale revless save A of a different ending, re-offered.
        return ChessyArchive.record(mk(['e4', 'e5']), cfg,
          { over: true, result: '1-0', reason: 'checkmate' }, 'legacy-fail', { endedAt: 5 })
          .catch(function () { /* A's own commit is failed by the wrap too */ });
      })
      .then(function () {
        CoachStore.archiveGame = real;
        const map = JSON.parse(localStorage.getItem('chessy-pending-archive-v1') || 'null');
        return map && map['legacy-fail'] ? map['legacy-fail'].rec.sans.join(',') : null;
      });
  });
  check(legacyFail === 'd4,d5,Qd3',
    'a revless pending revision whose reconcile fails is not overwritten by a stale revless re-offer');

  // ── The SAME invariant in the backup merge (mergeRecoverySources), exercised
  // through the Backup button. A fresh origin, so Chromium's ~10-per-burst
  // automatic-download throttle has full headroom here.
  await reset();
  await page.click('#tabReview');
  await page.waitForSelector('#gameListWrap:not([hidden])');

  // (2) A higher-rev IDENTICAL ending keeps its fresh, unrecomputable clocks
  // even when a stale lower-rev same-ending save is applied LAST. Parked copy
  // (fresh clocks, rev 7) applied first; persisted save is the same ending at a
  // LOWER rev 3 — comparing rev keeps the fresh clocks/rev, earliest createdAt.
  await page.evaluate(function () {
    let s = Chess.newGameState();
    function play(f, t) {
      const legal = Chess.legalMoves(s);
      s = Chess.playMove(s, legal.find(function (x) { return Chess.sqName(x.from) === f && Chess.sqName(x.to) === t; }));
    }
    play('f2', 'f3'); play('e7', 'e5'); play('g2', 'g4'); play('d8', 'h4'); // fool's mate
    localStorage.setItem('chessy-game-v1', JSON.stringify({
      fen: Chess.toFen(s), history: s.history, mode: 'pvp', gameId: 'sameend-x', endedAt: 100, rev: 3 }));
    localStorage.setItem('chessy-pending-archive-v1', JSON.stringify({
      'sameend-x': { w: 't', rec: { id: 'sameend-x', source: 'play', sans: ['f3', 'e5', 'g4', 'Qh4#'],
        result: '0-1', reason: 'checkmate', mode: 'pvp', plies: 4, createdAt: 200, rev: 7,
        clocks: [{ thinkMs: 222 }, null, null, null] } } }));
  });
  const [m1] = await Promise.all([page.waitForEvent('download'), page.click('#backupBtn')]);
  const mb1 = JSON.parse(fs.readFileSync(await m1.path(), 'utf8'));
  const sameend = mb1.stores.games.find(function (g) { return g.id === 'sameend-x'; });
  check(sameend && sameend.rev === 7 && sameend.clocks && sameend.clocks[0] && sameend.clocks[0].thinkMs === 222,
    'merge: a higher-rev identical ending keeps its fresh clocks/rev when a stale save is applied last');
  check(sameend && sameend.createdAt === 100,
    'merge: the identical ending still keeps the earliest completion time');
  await page.evaluate(function () {
    localStorage.removeItem('chessy-game-v1'); localStorage.removeItem('chessy-pending-archive-v1');
  });

  // A committed game whose id is '__proto__' (e.g. from a crafted restore) is
  // merged through the null-prototype maps: `byId[g.id] = g` on a plain object
  // would hit the __proto__ setter and drop the row (or corrupt the chain). It
  // must survive into the backup and must not pollute Object.prototype.
  await page.waitForTimeout(200);
  await page.evaluate(function () {
    return CoachStore.putGame({ id: '__proto__', source: 'play', sans: ['e4', 'e5'],
      result: '1-0', reason: 'resignation', mode: 'pvp', plies: 2, createdAt: 5, rev: 1 });
  });
  const [m2] = await Promise.all([page.waitForEvent('download'), page.click('#backupBtn')]);
  const mb2 = JSON.parse(fs.readFileSync(await m2.path(), 'utf8'));
  check(mb2.stores.games.some(function (g) { return g.id === '__proto__'; }),
    "merge: a committed '__proto__' game id is carried through a null-prototype map, not dropped");
  check(await page.evaluate(function () { return ({}).sans === undefined && ({}).id === undefined; }),
    'merge: a __proto__ game id does not pollute Object.prototype');
  await reset();
  await page.click('#tabReview');
  await page.waitForSelector('#gameListWrap:not([hidden])');

  // When ChessyArchive failed to load (partial cache eviction), the durability
  // queue is read STRAIGHT from localStorage so a game recoverable only from the
  // queue is still exported rather than silently dropped.
  await page.waitForTimeout(200);
  await page.evaluate(function () {
    window.__realChessyArchive = window.ChessyArchive;
    delete window.ChessyArchive;
    localStorage.setItem('chessy-pending-archive-v1', JSON.stringify({
      'raw-only': { w: 't', rec: { id: 'raw-only', source: 'play', sans: ['d4', 'd5'],
        result: '*', reason: 'imported', mode: 'pvp', plies: 2, createdAt: 6 } } }));
  });
  const [m3] = await Promise.all([page.waitForEvent('download'), page.click('#backupBtn')]);
  const mb3 = JSON.parse(fs.readFileSync(await m3.path(), 'utf8'));
  check(mb3.stores.games.some(function (g) { return g.id === 'raw-only'; }),
    'merge: the pending queue is exported from raw localStorage when ChessyArchive is unavailable');
  await page.evaluate(function () {
    window.ChessyArchive = window.__realChessyArchive;
    localStorage.removeItem('chessy-pending-archive-v1');
  });

  // ── (legacy save vs pending) A pre-rev upgrade: saving revised ending B
  // failed but PARKING B succeeded, so chessy-game-v1 still holds the OLDER
  // ending A under the same id; both are legitimately revless. The saved copy is
  // applied LAST in the merge, but it must NOT displace the pending revision — the
  // same preservation park() enforces at boot, so the only recoverable copy of
  // the revision is not silently omitted from the backup.
  await reset();
  await page.click('#tabReview');
  await page.waitForSelector('#gameListWrap:not([hidden])');
  await page.waitForTimeout(200);
  await page.evaluate(function () {
    // Pending B: the revless revision, recoverable only from the queue.
    localStorage.setItem('chessy-pending-archive-v1', JSON.stringify({
      'legacy-save-x': { w: 't', rec: { id: 'legacy-save-x', source: 'play',
        sans: ['d4', 'd5', 'Qd3'], result: '1-0', reason: 'checkmate', mode: 'pvp',
        plies: 3, clocks: [null, null, null], createdAt: 20 } } })); // no rev — legacy
    // Live save A: a valid finished game of a DIFFERENT ending, also revless.
    let s = Chess.newGameState();
    function play(f, t) {
      const legal = Chess.legalMoves(s);
      s = Chess.playMove(s, legal.find(function (x) { return Chess.sqName(x.from) === f && Chess.sqName(x.to) === t; }));
    }
    play('f2', 'f3'); play('e7', 'e5'); play('g2', 'g4'); play('d8', 'h4'); // fool's mate
    localStorage.setItem('chessy-game-v1', JSON.stringify({
      fen: Chess.toFen(s), history: s.history, mode: 'pvp', gameId: 'legacy-save-x',
      endedAt: 300 })); // no rev — legacy
  });
  const [ml] = await Promise.all([page.waitForEvent('download'), page.click('#backupBtn')]);
  const mbl = JSON.parse(fs.readFileSync(await ml.path(), 'utf8'));
  const legacyMerge = mbl.stores.games.find(function (g) { return g.id === 'legacy-save-x'; });
  check(legacyMerge && legacyMerge.sans.join(',') === 'd4,d5,Qd3',
    'merge: a revless live save does not displace a same-id revless pending revision');
  await page.evaluate(function () {
    localStorage.removeItem('chessy-game-v1'); localStorage.removeItem('chessy-pending-archive-v1');
  });

  // ── (needsRev merge) A needsRev live save (archive.js was absent when it
  // finished, so no rev was assigned) is a genuinely NEWER finish than an OLDER
  // committed row of the same id. The backup must export the save's newer ending,
  // NOT the stale committed one it outranks numerically — else a restore of that
  // backup would fence away the actual latest ending.
  await reset();
  await page.click('#tabReview');
  await page.waitForSelector('#gameListWrap:not([hidden])');
  await page.waitForTimeout(200);
  await page.evaluate(function () {
    // The older committed ending under this id, with a numeric rev.
    return CoachStore.putGame({ id: 'needsrev-merge', source: 'play', sans: ['e4', 'e5'],
      result: '1-0', reason: 'resignation', mode: 'pvp', plies: 2, createdAt: 1, rev: 5 })
      .then(function () {
        // The newer finish, saved but never archived (module absent): needsRev, no rev.
        let s = Chess.newGameState();
        function play(f, t) {
          const legal = Chess.legalMoves(s);
          s = Chess.playMove(s, legal.find(function (x) { return Chess.sqName(x.from) === f && Chess.sqName(x.to) === t; }));
        }
        play('f2', 'f3'); play('e7', 'e5'); play('g2', 'g4'); play('d8', 'h4'); // fool's mate
        localStorage.setItem('chessy-game-v1', JSON.stringify({
          fen: Chess.toFen(s), history: s.history, mode: 'pvp', gameId: 'needsrev-merge',
          endedAt: 300, needsRev: true })); // no rev
      });
  });
  const [mnr] = await Promise.all([page.waitForEvent('download'), page.click('#backupBtn')]);
  const mbnr = JSON.parse(fs.readFileSync(await mnr.path(), 'utf8'));
  const nrMerge = mbnr.stores.games.find(function (g) { return g.id === 'needsrev-merge'; });
  check(nrMerge && nrMerge.sans.join(',') === 'f3,e5,g4,Qh4#' && nrMerge.needsRev === undefined,
    'merge: a needsRev live save outranks an older committed row and exports clean');
  await page.evaluate(function () { localStorage.removeItem('chessy-game-v1'); });

  // ── (same-ending pending authority) A committed row B and a legacy revless
  // pending record CONFIRM the same ending B, while the live save holds a
  // DIFFERENT stale ending A (also revless). The saved A, applied last, must not
  // replace B on the revless tie — the pending record's confirmation of the
  // committed ending is authoritative (the same-ending branch records that win).
  await reset();
  await page.click('#tabReview');
  await page.waitForSelector('#gameListWrap:not([hidden])');
  await page.waitForTimeout(200);
  await page.evaluate(function () {
    return CoachStore.putGame({ id: 'agree-x', source: 'play', sans: ['d4', 'd5', 'Qd3'],
      result: '1-0', reason: 'checkmate', mode: 'pvp', plies: 3, createdAt: 10 }) // committed B, revless
      .then(function () {
        // Pending record confirms the SAME ending B (revless).
        localStorage.setItem('chessy-pending-archive-v1', JSON.stringify({
          'agree-x': { w: 't', rec: { id: 'agree-x', source: 'play', sans: ['d4', 'd5', 'Qd3'],
            result: '1-0', reason: 'checkmate', mode: 'pvp', plies: 3, clocks: [null, null, null],
            createdAt: 12 } } }));
        // Live save holds a DIFFERENT stale ending A (fool's mate), revless.
        let s = Chess.newGameState();
        function play(f, t) {
          const legal = Chess.legalMoves(s);
          s = Chess.playMove(s, legal.find(function (x) { return Chess.sqName(x.from) === f && Chess.sqName(x.to) === t; }));
        }
        play('f2', 'f3'); play('e7', 'e5'); play('g2', 'g4'); play('d8', 'h4');
        localStorage.setItem('chessy-game-v1', JSON.stringify({
          fen: Chess.toFen(s), history: s.history, mode: 'pvp', gameId: 'agree-x', endedAt: 300 }));
      });
  });
  const [ma] = await Promise.all([page.waitForEvent('download'), page.click('#backupBtn')]);
  const mba = JSON.parse(fs.readFileSync(await ma.path(), 'utf8'));
  const agree = mba.stores.games.find(function (g) { return g.id === 'agree-x'; });
  check(agree && agree.sans.join(',') === 'd4,d5,Qd3',
    'merge: a pending record confirming the committed ending keeps authority over a stale live save');
  await page.evaluate(function () {
    localStorage.removeItem('chessy-game-v1'); localStorage.removeItem('chessy-pending-archive-v1');
  });

  // ── (Rh4) The floor is seeded from COMMITTED rows at boot. A revision can
  // persist ONLY to IndexedDB (near quota, REV_KEY + the save + the pending
  // entry all fail while the commit succeeds); after a reload the localStorage
  // sources sit below it, so without a committed-row seed a new finish would mint
  // a lower rev that archiveGame() then rejects.
  await reset();
  await page.evaluate(function () {
    return CoachStore.putGame({ id: 'commit-only', source: 'play', sans: ['e4', 'e5'],
      result: '1-0', reason: 'resignation', mode: 'pvp', plies: 2, createdAt: 5, rev: 50 })
      .then(function () {
        // The localStorage carriers of that rev all failed to persist.
        localStorage.removeItem('chessy-archive-rev-v1');
        localStorage.removeItem('chessy-game-v1');
        localStorage.removeItem('chessy-pending-archive-v1');
      });
  });
  await page.reload();
  await page.waitForSelector('#board .square');
  await page.waitForTimeout(400); // let the async boot seed (listGames) settle
  const seeded = await page.evaluate(function () { return ChessyArchive.nextRev(); });
  check(seeded > 50,
    'the revision floor is seeded from committed rows at boot (a commit-only rev is not lost)');

  // ── (P2 exhaustion) The counter FAILS EXPLICITLY at the ceiling instead of
  // repeating a value. Seeded one below REV_MAX, nextRev() issues that last
  // distinct rev once; the next call — which could only re-emit the same
  // (unincrementable) integer — throws rather than handing two endings one rev.
  const exhaust = await page.evaluate(function () {
    const REV_MAX = Number.MAX_SAFE_INTEGER - 1;
    ChessyArchive.seedRev(REV_MAX - 1);
    const first = ChessyArchive.nextRev(); // the last issuable rev
    let threw = false, repeated = false;
    try {
      const second = ChessyArchive.nextRev();
      repeated = (second === first || second >= Number.MAX_SAFE_INTEGER);
    } catch (e) { threw = true; }
    return { first: first, threw: threw, repeated: repeated };
  });
  check(exhaust.first === Number.MAX_SAFE_INTEGER - 1 && exhaust.threw && !exhaust.repeated,
    'nextRev issues the last distinct rev once, then fails explicitly rather than repeating at the ceiling');

  // ── (needsRev) A finish that could not be assigned a rev because the archive
  // module was missing is persisted with a `needsRev` marker (rev:null). It is
  // NOT pre-rev legacy data: on the next boot (module present) the boot re-offer
  // mints a real rev ABOVE the committed floor, so archiveGame() ranks the
  // genuinely-newer finish over an older committed row instead of discarding it.
  await reset();
  await page.evaluate(function () {
    // The older committed ending under the same id (a numeric rev).
    return CoachStore.putGame({ id: 'needsrev-x', source: 'play', sans: ['e4', 'e5'],
      result: '1-0', reason: 'resignation', mode: 'pvp', plies: 2, createdAt: 1, rev: 3 });
  });
  await t.inject(function () {
    // The newer finish, saved but never archived (module was gone): needsRev, no rev.
    localStorage.setItem('chessy-game-v1', JSON.stringify({
      fen: 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3',
      history: [
        { move: { from: 53, to: 45, piece: 'wP', captured: null, promotion: null, ep: false, castle: null, double: false }, san: 'f3' },
        { move: { from: 12, to: 28, piece: 'bP', captured: null, promotion: null, ep: false, castle: null, double: true }, san: 'e5' },
        { move: { from: 54, to: 38, piece: 'wP', captured: null, promotion: null, ep: false, castle: null, double: true }, san: 'g4' },
        { move: { from: 3, to: 39, piece: 'bQ', captured: null, promotion: null, ep: false, castle: null, double: false }, san: 'Qh4#' }
      ],
      positions: {
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -': 1,
        'rnbqkbnr/pppppppp/8/8/8/5P2/PPPPP1PP/RNBQKBNR b KQkq -': 1,
        'rnbqkbnr/pppp1ppp/8/4p3/8/5P2/PPPPP1PP/RNBQKBNR w KQkq -': 1,
        'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq -': 1,
        'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq -': 1
      },
      mode: 'pvp', difficulty: '2', timeControl: 'none', clocks: null, timeForfeit: null,
      flipped: false, gameId: 'needsrev-x', endedAt: 40, needsRev: true
    }));
  });
  await page.waitForTimeout(600); // let the boot seed → re-offer mint + record settle
  const needsRev = await page.evaluate(function () { return CoachStore.getGame('needsrev-x'); });
  check(needsRev && needsRev.sans.join(',') === 'f3,e5,g4,Qh4#' &&
    Number.isFinite(needsRev.rev) && needsRev.rev > 3,
    'a module-absent finish (needsRev) is minted a rev on boot and archived over an older committed row');

  // ── The next three sections exercise the deferred rev allocation while the
  // committed-row floor seed (revReady) is still in flight. `CoachStore.listGames`
  // is wrapped BEFORE store.js defines it to HOLD while `localStorage.__lgHold`
  // is '1', so a finish (and the boot re-offer) reliably occurs with revReady
  // still pending; the test releases the hold, then asserts the settled state.
  await page.addInitScript(function () {
    let real;
    Object.defineProperty(window, 'CoachStore', {
      configurable: true,
      get: function () { return real; },
      set: function (v) {
        real = v;
        if (v && typeof v.listGames === 'function' && !v.__heldListGames) {
          const orig = v.listGames.bind(v);
          v.listGames = function () {
            const self = this, args = arguments;
            function held() { try { return localStorage.getItem('__lgHold') === '1'; } catch (e) { return false; } }
            function run() { return orig.apply(self, args); }
            // Transient-failure injection: reject the first `__lgFailN` calls
            // (decrementing the counter) so the boot floor-seed retry is exercised.
            try {
              const n = parseInt(localStorage.getItem('__lgFailN') || '0', 10);
              if (n > 0) {
                localStorage.setItem('__lgFailN', String(n - 1));
                return Promise.reject(new Error('listGames transient fail'));
              }
            } catch (e) { /* ignore */ }
            if (!held()) return run();
            return new Promise(function (resolve, reject) {
              (function wait() {
                if (!held()) return run().then(resolve, reject);
                setTimeout(wait, 20);
              })();
            });
          };
          v.__heldListGames = true;
        }
      }
    });
  });

  // (await floor) A finish must not obtain a rev until the committed-row floor
  // seed settles. The seed is HELD while a fool's mate finishes, so revReady is
  // still pending at finish; after release the rev is minted ABOVE the committed
  // floor (50) — never the low value a pre-seed nextRev() would issue.
  await reset();
  await page.evaluate(function () {
    return CoachStore.putGame({ id: 'floor-other', source: 'play', sans: ['e4', 'e5'],
      result: '1-0', reason: 'resignation', mode: 'pvp', plies: 2, createdAt: 1, rev: 50 })
      .then(function () {
        localStorage.removeItem('chessy-archive-rev-v1');
        localStorage.removeItem('chessy-game-v1');
        localStorage.removeItem('chessy-pending-archive-v1');
        localStorage.setItem('__lgHold', '1'); // hold the boot floor seed
      });
  });
  await page.reload();
  await page.waitForSelector('#board .square');
  await t.newGame({ mode: 'pvp' });
  await t.mv('f2', 'f3'); await t.mv('e7', 'e5');
  await t.mv('g2', 'g4'); await t.mv('d8', 'h4'); // finishes while the seed is held
  await page.waitForSelector('#gameOverDialog[open]');
  await page.evaluate(function () { localStorage.setItem('__lgHold', '0'); }); // release → seed, then mint
  await page.waitForTimeout(400);
  const awaited = await page.evaluate(function () {
    const save = JSON.parse(localStorage.getItem('chessy-game-v1') || 'null');
    return CoachStore.getGame(save && save.gameId).then(function (g) {
      return { committedRev: g && g.rev, savedRev: save && save.rev };
    });
  });
  check(Number.isFinite(awaited.committedRev) && awaited.committedRev > 50 && awaited.savedRev > 50,
    'a finish while the boot seed is pending waits for revReady and mints a rev above the committed floor');

  // (undo during pending revReady) The player finishes A, closes the dialog and
  // undoes it while revReady is still held. The deferred callback must NOT stamp
  // A's rev onto the now-unfinished live save — otherwise the next finish would
  // reuse it instead of taking a higher one.
  await reset();
  await page.evaluate(function () { localStorage.setItem('__lgHold', '1'); });
  await page.reload();
  await page.waitForSelector('#board .square');
  await t.newGame({ mode: 'pvp' });
  await t.mv('f2', 'f3'); await t.mv('e7', 'e5');
  await t.mv('g2', 'g4'); await t.mv('d8', 'h4'); // A finishes while revReady is held
  await page.waitForSelector('#gameOverDialog[open]');
  await page.click('#gameOverClose');
  await page.click('#undo'); // takes A back; clears gameEndedAt/gameRev
  await page.evaluate(function () { localStorage.setItem('__lgHold', '0'); }); // release → A's stray callback runs
  await page.waitForTimeout(400);
  const undoLeak = await page.evaluate(function () {
    const save = JSON.parse(localStorage.getItem('chessy-game-v1') || 'null');
    return { savedRev: save && save.rev, over: !!(save && Number.isFinite(save.endedAt)) };
  });
  check(undoLeak.savedRev == null && !undoLeak.over,
    'an Undo while revReady is pending does not leak the finish rev onto the now-unfinished live save');

  // (rematch during pending revReady) A finishes, then Rematch starts a NEW game
  // before revReady settles. A is still recorded for durability, but with its OWN
  // completion time — not the later game's (or callback time). The completion time
  // is snapshotted at finish, so the archive chronology can't be corrupted.
  await reset();
  await page.evaluate(function () { localStorage.setItem('__lgHold', '1'); });
  await page.reload();
  await page.waitForSelector('#board .square');
  await t.newGame({ mode: 'pvp' });
  await t.mv('f2', 'f3'); await t.mv('e7', 'e5');
  await t.mv('g2', 'g4'); await t.mv('d8', 'h4'); // A finishes while revReady is held
  await page.waitForSelector('#gameOverDialog[open]');
  const aInfo = await page.evaluate(function () {
    const save = JSON.parse(localStorage.getItem('chessy-game-v1'));
    return { id: save.gameId, endedAt: save.endedAt };
  });
  await page.click('#gameOverRematch'); // new game (new id); gameEndedAt reset to null
  await page.evaluate(function () { localStorage.setItem('__lgHold', '0'); }); // release → A recorded for durability
  await page.waitForTimeout(400);
  const rematchTime = await page.evaluate(function (id) { return CoachStore.getGame(id); }, aInfo.id);
  check(rematchTime && rematchTime.sans.join(',') === 'f3,e5,g4,Qh4#' &&
    rematchTime.createdAt === aInfo.endedAt,
    'a finish archived after a Rematch keeps its own completion time, not the later game\'s');
  await page.evaluate(function () { localStorage.removeItem('__lgHold'); });

  // (seed retry) A TRANSIENT listGames() rejection must not fulfil revReady
  // without the committed floor — a finish would then mint a rev BELOW an existing
  // committed row, which archiveGame() keeps (resolving + clearing the pending
  // token), permanently outranking the genuine latest ending. The read fails twice,
  // the retry then seeds the floor (50), and the finish mints ABOVE it.
  await reset();
  await page.evaluate(function () {
    return CoachStore.putGame({ id: 'retry-other', source: 'play', sans: ['e4', 'e5'],
      result: '1-0', reason: 'resignation', mode: 'pvp', plies: 2, createdAt: 1, rev: 50 })
      .then(function () {
        localStorage.removeItem('chessy-archive-rev-v1');
        localStorage.removeItem('chessy-game-v1');
        localStorage.removeItem('chessy-pending-archive-v1');
        localStorage.setItem('__lgFailN', '2'); // first two boot floor-reads reject
      });
  });
  await page.reload();
  await page.waitForSelector('#board .square');
  await t.newGame({ mode: 'pvp' });
  await t.mv('f2', 'f3'); await t.mv('e7', 'e5');
  await t.mv('g2', 'g4'); await t.mv('d8', 'h4');
  await page.waitForSelector('#gameOverDialog[open]');
  await page.waitForTimeout(700); // retries (~2×150ms) settle, then the rev is minted + recorded
  const retried = await page.evaluate(function () {
    const save = JSON.parse(localStorage.getItem('chessy-game-v1') || 'null');
    return CoachStore.getGame(save && save.gameId).then(function (g) { return { committedRev: g && g.rev }; });
  });
  check(Number.isFinite(retried.committedRev) && retried.committedRev > 50,
    'a transient floor-read failure is retried so a finish still mints above the committed floor');
  await page.evaluate(function () { localStorage.removeItem('__lgFailN'); });

  await reset(); // leave a clean store for the console-error check
});
