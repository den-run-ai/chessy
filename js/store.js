/*
 * Chessy coaching store — the versioned IndexedDB archive behind the
 * Review/Train/Progress views. Two object stores (schema v1):
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
  const DB_VERSION = 1;

  let dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise(function (resolve, reject) {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = function () {
          const db = req.result;
          if (!db.objectStoreNames.contains('games')) {
            db.createObjectStore('games', { keyPath: 'id', autoIncrement: true });
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
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('transaction aborted')); };
      });
    });
  }

  function addGame(game) { return tx('games', 'readwrite', function (s) { return s.add(game); }); }
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
  function listCards() { return tx('cards', 'readonly', function (s) { return s.getAll(); }); }

  function dueCards(now) {
    return tx('cards', 'readonly', function (s) {
      return s.index('due').getAll(IDBKeyRange.upperBound(now));
    }).then(function (cards) { return cards.sort(function (a, b) { return a.due - b.due; }); });
  }

  // Whole-archive JSON snapshot for backup.
  function exportAll() {
    return Promise.all([listGames(), listCards()]).then(function (r) {
      return { format: 'chessy-coach', version: DB_VERSION, exportedAt: Date.now(), games: r[0], cards: r[1] };
    });
  }

  // Restore a snapshot by APPENDING: records get fresh ids and card→game
  // links are remapped, so importing into a non-empty archive never
  // collides with (or overwrites) existing records.
  function importAll(data) {
    if (!data || data.format !== 'chessy-coach' ||
        !Array.isArray(data.games) || !Array.isArray(data.cards)) {
      return Promise.reject(new Error('not a chessy-coach backup'));
    }
    const idMap = new Map();
    let chain = Promise.resolve();
    data.games.forEach(function (g) {
      chain = chain.then(function () {
        const copy = Object.assign({}, g);
        const oldId = copy.id;
        delete copy.id;
        return addGame(copy).then(function (newId) { idMap.set(oldId, newId); });
      });
    });
    data.cards.forEach(function (c) {
      chain = chain.then(function () {
        const copy = Object.assign({}, c);
        delete copy.id;
        copy.gameId = idMap.get(copy.gameId) || null;
        return addCard(copy);
      });
    });
    return chain.then(function () {
      return { games: data.games.length, cards: data.cards.length };
    });
  }

  function deleteAll() {
    return tx('games', 'readwrite', function (s) { return s.clear(); })
      .then(function () { return tx('cards', 'readwrite', function (s) { return s.clear(); }); });
  }

  global.CoachStore = {
    addGame: addGame,
    getGame: getGame,
    listGames: listGames,
    deleteGame: deleteGame,
    addCard: addCard,
    updateCard: updateCard,
    listCards: listCards,
    dueCards: dueCards,
    exportAll: exportAll,
    importAll: importAll,
    deleteAll: deleteAll
  };
})(typeof window !== 'undefined' ? window : globalThis);
