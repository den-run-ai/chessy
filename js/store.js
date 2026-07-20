/*
 * Chessy coaching store — the IndexedDB game archive behind the Review
 * view. Two object stores:
 *
 *   games: { id (auto), sig (unique), source ('play'|'import'), tags,
 *            gameSeq, sans, playerColor, clocks, result, reason, mode,
 *            difficulty, timeControl, plies, createdAt }
 *   cards: { id (auto), gameId, ... } — lesson cards (created by the
 *            review flow; the store carries the schema from day one so
 *            adding the flow needs no version bump)
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
  function getGame(id) { return tx('games', 'readonly', function (s) { return s.get(id); }); }
  function getGameBySig(sig) {
    return tx('games', 'readonly', function (s) { return s.index('sig').get(sig); });
  }

  function listGames() {
    return tx('games', 'readonly', function (s) { return s.getAll(); })
      .then(function (games) { return games.sort(function (a, b) { return b.createdAt - a.createdAt; }); });
  }

  global.CoachStore = {
    addGame: addGame,
    getGame: getGame,
    getGameBySig: getGameBySig,
    listGames: listGames
  };
})(typeof window !== 'undefined' ? window : globalThis);
