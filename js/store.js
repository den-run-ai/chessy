/*
 * Chessy coaching store — the versioned IndexedDB archive behind the
 * Review/Train/Progress views. Two object stores (schema v2 — v2 added
 * the unique games.sig index):
 *
 *   games: { id (auto), source ('play'|'import'), tags, sans, result,
 *            reason, mode, difficulty, timeControl, plies, createdAt }
 *   cards: { id (auto), gameId, ply, fenBefore, playedSan, bestSan,
 *            bestMove {from,to,promotion}, bestScore, playedScore, lossCp,
 *            cause, lesson, reflection, createdAt, due, step,
 *            attempts: [{ at, grade, correct }] }
 *
 * `due` is a timestamp (ms); `step` indexes the fixed spaced-review ladder
 * (see Coach). Everything is promise-based; the DB opens lazily on first
 * use so browsers without IndexedDB (or private modes that block it) fail
 * per-call instead of at load.
 *
 * Note: all *.github.io project sites share one web origin per user, so
 * this archive is reachable by sibling GitHub Pages apps. Fine for a
 * casual training log; a dedicated domain is the fix before anything
 * sensitive is stored (tracked in the coaching roadmap).
 */
(function (global) {
  'use strict';

  const DB_NAME = 'chessy-coach';
  // v2 adds a UNIQUE index on games.sig: each tab's in-memory dedupe is
  // only a snapshot, so two tabs reconciling the same finished game could
  // both pass their local check — the database itself must refuse the
  // second insert. Records without a sig (imports, pre-v2 rows) are not
  // indexed and carry no constraint.
  const DB_VERSION = 2;

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
          if (!games.indexNames.contains('sig')) {
            games.createIndex('sig', 'sig', { unique: true });
          }
          if (!db.objectStoreNames.contains('cards')) {
            const cards = db.createObjectStore('cards', { keyPath: 'id', autoIncrement: true });
            cards.createIndex('due', 'due');
            cards.createIndex('gameId', 'gameId');
          }
        };
        req.onsuccess = function () { resolve(req.result); };
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

  function addGame(game) { return tx('games', 'readwrite', function (s) { return s.add(game); }); }
  function updateGame(game) { return tx('games', 'readwrite', function (s) { return s.put(game); }); }
  function getGame(id) { return tx('games', 'readonly', function (s) { return s.get(id); }); }

  function listGames() {
    return tx('games', 'readonly', function (s) { return s.getAll(); })
      .then(function (games) { return games.sort(function (a, b) { return b.createdAt - a.createdAt; }); });
  }

  function deleteGame(id) {
    // Cards belong to their game — remove them with it.
    return tx('cards', 'readwrite', function (s) {
      const idx = s.index('gameId').openCursor(IDBKeyRange.only(id));
      idx.onsuccess = function () {
        const c = idx.result;
        if (c) { c.delete(); c.continue(); }
      };
      return null;
    }).then(function () {
      return tx('games', 'readwrite', function (s) { return s.delete(id); });
    });
  }

  function addCard(card) { return tx('cards', 'readwrite', function (s) { return s.add(card); }); }
  function updateCard(card) { return tx('cards', 'readwrite', function (s) { return s.put(card); }); }
  function deleteCard(id) { return tx('cards', 'readwrite', function (s) { return s.delete(id); }); }
  function listCards() { return tx('cards', 'readonly', function (s) { return s.getAll(); }); }

  function dueCards(now) {
    return tx('cards', 'readonly', function (s) {
      return s.index('due').getAll(IDBKeyRange.upperBound(now));
    }).then(function (cards) { return cards.sort(function (a, b) { return a.due - b.due; }); });
  }

  // Whole-archive JSON snapshot for backup. BOTH stores are read in ONE
  // readonly transaction: two independent reads could observe different
  // database moments when the export overlaps a delete or import, and a
  // backup with orphaned cards cannot remap its gameIds on restore.
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
  // collides with (or overwrites) existing records. `isCancelled` (optional)
  // is consulted between records — a restore raced by "Delete all training
  // data" stops instead of writing deleted data back. The per-record
  // transactions cannot be atomic across the whole restore, so on ANY
  // failure (quota, bad record, cancellation) the committed prefix is
  // rolled back — a retry after fixing the cause must not duplicate it.
  function importAll(data, isCancelled) {
    if (!data || data.format !== 'chessy-coach' ||
        !Array.isArray(data.games) || !Array.isArray(data.cards)) {
      return Promise.reject(new Error('not a chessy-coach backup'));
    }
    // Validate every record BEFORE the first write: a structurally broken
    // backup (a card without a position, a non-numeric due time) would
    // otherwise commit, report success, and then break Train/Review when
    // the record is used. Rejecting up front leaves the archive unchanged.
    function badGame(g) {
      return !g || typeof g !== 'object' || !Array.isArray(g.sans) ||
        !g.sans.every(function (s) { return typeof s === 'string'; }) ||
        typeof g.result !== 'string';
    }
    function badCard(c) {
      return !c || typeof c !== 'object' ||
        typeof c.fenBefore !== 'string' || c.fenBefore === '' ||
        typeof c.due !== 'number' || !isFinite(c.due) ||
        !Array.isArray(c.attempts) ||
        !(c.bestMove === null || c.bestMove === undefined ||
          (typeof c.bestMove === 'object' &&
           typeof c.bestMove.from === 'number' && typeof c.bestMove.to === 'number'));
    }
    if (data.games.some(badGame) || data.cards.some(badCard)) {
      return Promise.reject(new Error('backup contains invalid records'));
    }
    function guard() {
      if (isCancelled && isCancelled()) throw new Error('restore cancelled');
    }
    const idMap = new Map();
    const addedGames = [], addedCards = [];
    let chain = Promise.resolve();
    data.games.forEach(function (g) {
      chain = chain.then(function () {
        guard();
        const copy = Object.assign({}, g);
        const oldId = copy.id;
        delete copy.id;
        // A restored copy is a NEW record, not the original play-game
        // instance: keeping the sig would trip the unique index (and
        // wrongly claim the dedupe identity).
        delete copy.sig;
        return addGame(copy).then(function (newId) {
          idMap.set(oldId, newId);
          addedGames.push(newId);
        });
      });
    });
    data.cards.forEach(function (c) {
      chain = chain.then(function () {
        guard();
        const copy = Object.assign({}, c);
        delete copy.id;
        copy.gameId = idMap.get(copy.gameId) || null;
        return addCard(copy).then(function (id) { addedCards.push(id); });
      });
    });
    return chain.then(function () {
      return { games: data.games.length, cards: data.cards.length };
    }, function (e) {
      let undo = Promise.resolve();
      addedCards.forEach(function (id) {
        undo = undo.then(function () { return deleteCard(id); })
          .catch(function () { /* keep rolling back the rest */ });
      });
      addedGames.forEach(function (id) {
        undo = undo.then(function () {
          return tx('games', 'readwrite', function (s) { return s.delete(id); });
        }).catch(function () { /* keep rolling back the rest */ });
      });
      return undo.then(function () { throw e; });
    });
  }

  function deleteAll() {
    return tx('games', 'readwrite', function (s) { return s.clear(); })
      .then(function () { return tx('cards', 'readwrite', function (s) { return s.clear(); }); });
  }

  global.CoachStore = {
    addGame: addGame,
    updateGame: updateGame,
    getGame: getGame,
    listGames: listGames,
    deleteGame: deleteGame,
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
