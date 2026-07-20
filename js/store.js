/*
 * Chessy coaching store — the IndexedDB game archive behind the Review
 * view. Two object stores:
 *
 *   games: { id (auto), sig (unique), source ('play'|'import'), tags,
 *            gameSeq, sans, playerColor, clocks, result, reason, mode,
 *            difficulty, timeControl, plies, createdAt }
 *   cards: { id (auto), gameId, ply, fenBefore, playedSan, bestSan,
 *            bestMove {from,to,promotion}, bestScore, playedScore, lossCp,
 *            kind, cause, lesson, reflection, createdAt, due, step,
 *            attempts } — lesson cards saved by the review flow
 *            (`due`/`step`/`attempts` drive the spaced review that lands
 *            in the next slice)
 *
 * Everything is promise-based; the DB opens lazily on first use so
 * browsers without IndexedDB (or private modes that block it) fail
 * per-call instead of at load.
 *
 * Concurrency model: Chessy assumes ONE active tab. The unique `sig`
 * index makes the single cross-tab hazard (two tabs archiving the same
 * finished game) safe at the database level; everything else is
 * last-writer-wins, which is fine for a personal training log.
 *
 * Note: all *.github.io project sites share one web origin per user, so
 * this archive is reachable by sibling GitHub Pages apps. Fine for a
 * casual training log; a dedicated domain is the fix before anything
 * sensitive is stored (tracked in the coaching roadmap).
 */
(function (global) {
  'use strict';

  const DB_NAME = 'chessy-coach';
  // v4: versions 1-3 only ever existed on an abandoned development branch
  // (PR #38); the upgrade path drops that branch's internal `meta` store
  // and keeps its games/cards. Fresh installs create this schema directly.
  const DB_VERSION = 4;
  // Cards start at -1 (the immediate learning step), then advance through
  // the six fixed 1/3/7/14/30/90-day rungs owned by Coach.
  const MIN_CARD_STEP = -1;
  const MAX_CARD_STEP = 5;

  let dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise(function (resolve, reject) {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = function () {
          const db = req.result;
          const games = db.objectStoreNames.contains('games')
            ? req.transaction.objectStore('games')
            : db.createObjectStore('games', { keyPath: 'id', autoIncrement: true });
          // The unique index is the dedupe backstop: an in-memory "already
          // archived" check cannot survive reloads or a second tab, so the
          // database itself must refuse a duplicate insert.
          if (!games.indexNames.contains('sig')) {
            games.createIndex('sig', 'sig', { unique: true });
          }
          if (!db.objectStoreNames.contains('cards')) {
            const cards = db.createObjectStore('cards', { keyPath: 'id', autoIncrement: true });
            cards.createIndex('due', 'due');
            cards.createIndex('gameId', 'gameId');
          }
          if (db.objectStoreNames.contains('meta')) db.deleteObjectStore('meta');
        };
        req.onsuccess = function () {
          const db = req.result;
          // Yield to future schema upgrades: without this handler an open
          // connection blocks another context's upgrade indefinitely.
          // Closing drops this connection; the next call reopens lazily at
          // the new version.
          db.onversionchange = function () {
            db.close();
            dbPromise = null;
          };
          resolve(db);
        };
        req.onerror = function () { dbPromise = null; reject(req.error); };
      });
    }
    return dbPromise;
  }

  // Run `fn(objectStore)` in a transaction; resolves with the result of the
  // request `fn` returns (or undefined) once the transaction commits.
  function tx(storeName, mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        const t = db.transaction(storeName, mode);
        const req = fn(t.objectStore(storeName));
        t.oncomplete = function () { resolve(req ? req.result : undefined); };
        // Prefer the REQUEST's error: when a request fails (e.g. a
        // ConstraintError from the unique sig index) transaction.error
        // can still be null in the bubbled error/abort events, and
        // callers need the real name to react to it.
        t.onerror = function () { reject((req && req.error) || t.error); };
        t.onabort = function () {
          reject((req && req.error) || t.error || new Error('transaction aborted'));
        };
      });
    });
  }

  function addGame(game) {
    return tx('games', 'readwrite', function (s) { return s.add(game); });
  }
  function updateGame(game) {
    return tx('games', 'readwrite', function (s) { return s.put(game); });
  }
  function getGame(id) { return tx('games', 'readonly', function (s) { return s.get(id); }); }
  function getGameBySig(sig) {
    return tx('games', 'readonly', function (s) { return s.index('sig').get(sig); });
  }

  function listGames() {
    return tx('games', 'readonly', function (s) { return s.getAll(); })
      .then(function (games) { return games.sort(function (a, b) { return b.createdAt - a.createdAt; }); });
  }

  function addCard(card) {
    return tx('cards', 'readwrite', function (s) { return s.add(card); });
  }
  function updateCard(card) {
    return tx('cards', 'readwrite', function (s) { return s.put(card); });
  }
  function deleteCard(id) { return tx('cards', 'readwrite', function (s) { return s.delete(id); }); }
  function listCards() { return tx('cards', 'readonly', function (s) { return s.getAll(); }); }

  function dueCards(now) {
    return tx('cards', 'readonly', function (s) {
      return s.index('due').getAll(IDBKeyRange.upperBound(now));
    }).then(function (cards) { return cards.sort(function (a, b) { return a.due - b.due; }); });
  }

  // Whole-archive JSON snapshot for backup. BOTH stores are read in ONE
  // readonly transaction: two independent reads could observe different
  // database moments when the export overlaps other writes, and a backup
  // with orphaned cards cannot remap its gameIds on restore.
  function exportAll() {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        const t = db.transaction(['games', 'cards'], 'readonly');
        const gReq = t.objectStore('games').getAll();
        const cReq = t.objectStore('cards').getAll();
        t.oncomplete = function () {
          resolve({
            format: 'chessy-coach', version: DB_VERSION, exportedAt: Date.now(),
            games: gReq.result.sort(function (a, b) { return b.createdAt - a.createdAt; }),
            cards: cReq.result
          });
        };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('transaction aborted')); };
      });
    });
  }

  // Restore a snapshot by APPENDING: records get fresh ids and card→game
  // links are remapped, so importing into a non-empty archive never
  // collides with (or overwrites) existing records.
  //
  // Validation is fail-before-write: every record is checked BEFORE the
  // first write, so a structurally broken backup rejects with the archive
  // unchanged. (Per-record writes after that cannot be atomic as a group;
  // a mid-restore storage failure reports how far it got — there is no
  // rollback machinery in this slice.)
  function importAll(data) {
    if (!data || data.format !== 'chessy-coach' ||
        !Array.isArray(data.games) || !Array.isArray(data.cards)) {
      return Promise.reject(new Error('not a chessy-coach backup'));
    }
    // Games must REPLAY, not merely be arrays of strings: a record with
    // garbage SANs would restore "successfully" and then always fail to
    // open in Review. (Engine checks are skipped only where the engine
    // script isn't loaded, e.g. unit shims.)
    function badGame(g) {
      if (!g || typeof g !== 'object' || !Array.isArray(g.sans) ||
          !g.sans.every(function (s) { return typeof s === 'string'; }) ||
          typeof g.result !== 'string' ||
          typeof g.createdAt !== 'number' || !isFinite(g.createdAt) ||
          !Number.isInteger(g.plies) || g.plies !== g.sans.length ||
          (g.playerColor !== undefined &&
            ['w', 'b', 'both'].indexOf(g.playerColor) < 0)) return true;
      if (typeof Chess !== 'undefined') {
        try { Chess.replaySans(g.sans); } catch (e) { return true; }
      }
      return false;
    }
    // A card must be ANSWERABLE: the position parses, both kings exist,
    // and the saved best move is LEGAL there — otherwise Train renders a
    // card no answer can ever match.
    function badCard(c) {
      if (!c || typeof c !== 'object' ||
          typeof c.fenBefore !== 'string' || c.fenBefore === '' ||
          typeof c.due !== 'number' || !isFinite(c.due) ||
          !Number.isInteger(c.step) ||
          c.step < MIN_CARD_STEP || c.step > MAX_CARD_STEP ||
          !Array.isArray(c.attempts) ||
          !c.attempts.every(function (a) {
            return a && typeof a === 'object' &&
              typeof a.at === 'number' && isFinite(a.at) &&
              ['again', 'hard', 'good'].indexOf(a.grade) >= 0 &&
              typeof a.correct === 'boolean';
          }) ||
          !(typeof c.bestMove === 'object' && c.bestMove !== null &&
            typeof c.bestMove.from === 'number' && typeof c.bestMove.to === 'number')) {
        return true;
      }
      if (typeof Chess !== 'undefined') {
        try {
          const s = Chess.parseFen(c.fenBefore);
          if (s.board.indexOf('wK') < 0 || s.board.indexOf('bK') < 0) return true;
          const legal = Chess.legalMoves(s).some(function (m) {
            return m.from === c.bestMove.from && m.to === c.bestMove.to &&
              (m.promotion || null) === (c.bestMove.promotion || null);
          });
          if (!legal) return true;
        } catch (e) { return true; }
      }
      return false;
    }
    if (data.games.some(badGame) || data.cards.some(badCard)) {
      return Promise.reject(new Error('backup contains invalid records'));
    }
    // References must RESOLVE before the first write, or the append below
    // would silently detach a card from its game (fail-before-write also
    // covers the links, not just record shapes). Intentionally null
    // gameIds are legitimate; a dangling or ambiguous one is not.
    const gameIds = new Set();
    for (const g of data.games) {
      if (!Number.isInteger(g.id) || gameIds.has(g.id)) {
        return Promise.reject(new Error('backup contains missing or duplicate game ids'));
      }
      gameIds.add(g.id);
    }
    if (data.cards.some(function (c) {
      return c.gameId !== null && c.gameId !== undefined && !gameIds.has(c.gameId);
    })) {
      return Promise.reject(new Error('backup contains cards referencing missing games'));
    }
    const idMap = new Map();
    let done = 0;
    let chain = Promise.resolve();
    data.games.forEach(function (g) {
      chain = chain.then(function () {
        const copy = Object.assign({}, g);
        const oldId = copy.id;
        delete copy.id;
        // A restored copy is a NEW record, not the original play-game
        // instance: keeping the sig would trip the unique index (and
        // wrongly claim the dedupe identity).
        delete copy.sig;
        // A malformed optional scan is dropped rather than rejecting the
        // whole backup — the game itself is fine and can be re-scanned.
        if (copy.scan && (typeof copy.scan !== 'object' ||
            !Array.isArray(copy.scan.moments) || !Array.isArray(copy.scan.evals))) {
          delete copy.scan;
        }
        return addGame(copy).then(function (newId) {
          idMap.set(oldId, newId);
          done++;
        });
      });
    });
    data.cards.forEach(function (c) {
      chain = chain.then(function () {
        const copy = Object.assign({}, c);
        delete copy.id;
        // Validated above: a non-null gameId always resolves in idMap.
        copy.gameId = copy.gameId === null || copy.gameId === undefined
          ? null : idMap.get(copy.gameId);
        return addCard(copy).then(function () { done++; });
      });
    });
    return chain.then(function () {
      return { games: data.games.length, cards: data.cards.length };
    }, function (e) {
      const total = data.games.length + data.cards.length;
      throw new Error((e && e.message ? e.message : e) +
        ' (' + done + '/' + total + ' records restored — re-importing may duplicate them)');
    });
  }

  // BOTH content stores clear in ONE readwrite transaction, so a failure
  // leaves everything intact and a success leaves nothing behind — no
  // intermediate no-games-but-old-cards state.
  function deleteAll() {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        const t = db.transaction(['games', 'cards'], 'readwrite');
        t.objectStore('games').clear();
        t.objectStore('cards').clear();
        t.oncomplete = function () { resolve(); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('transaction aborted')); };
      });
    });
  }

  global.CoachStore = {
    addGame: addGame,
    updateGame: updateGame,
    getGame: getGame,
    getGameBySig: getGameBySig,
    listGames: listGames,
    addCard: addCard,
    updateCard: updateCard,
    deleteCard: deleteCard,
    listCards: listCards,
    dueCards: dueCards,
    exportAll: exportAll,
    importAll: importAll,
    deleteAll: deleteAll
  };
})(typeof window !== 'undefined' ? window : globalThis);
