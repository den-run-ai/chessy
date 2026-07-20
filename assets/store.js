/*
 * Chessy coaching store — the IndexedDB archive behind the coaching
 * features (roadmap #23). Two object stores, created up front so later
 * slices need no version bump:
 *
 *   games: { id (the game's UUID from app.js), source ('play'), tags,
 *            sans, playerColor, clocks, result, reason, mode, difficulty,
 *            timeControl, plies, createdAt }
 *   cards: { id (auto), gameId, ply, ... } — lesson cards (a later slice)
 *
 * The games keyPath is the app's own per-game UUID: a re-shown ending of
 * the same game instance (reload, undo → replay, reopened game-over
 * dialog) overwrites its single record via archiveGame(), while New
 * game/Rematch mint a new UUID and therefore a new record. archiveGame
 * additionally keeps the original createdAt on overwrite and forks a
 * fresh id when the existing record is a DIFFERENT completion of the same
 * instance (cloned tabs that diverged) — atomically, so it stays correct
 * in ANY number of tabs.
 *
 * Everything is promise-based; the DB opens lazily on first use so
 * browsers without IndexedDB (or private modes that block it) fail
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
  // v5 is the FIRST released schema: v1–v4 only ever existed on
  // pre-release preview branches (PR #38 and the first cut of its split),
  // so the upgrade drops any stores such a preview left behind and
  // recreates them. Fresh installs run the same path from nothing.
  const DB_VERSION = 5;

  let dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise(function (resolve, reject) {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = function () {
          const db = req.result;
          for (const name of Array.from(db.objectStoreNames)) {
            db.deleteObjectStore(name);
          }
          db.createObjectStore('games', { keyPath: 'id' });
          const cards = db.createObjectStore('cards', { keyPath: 'id', autoIncrement: true });
          cards.createIndex('due', 'due');
          cards.createIndex('gameId', 'gameId');
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
        // Prefer the REQUEST's error: transaction.error can still be null
        // in the bubbled error/abort events, and callers need the real
        // failure to report it.
        t.onerror = function () { reject((req && req.error) || t.error); };
        t.onabort = function () {
          reject((req && req.error) || t.error || new Error('transaction aborted'));
        };
      });
    });
  }

  function putGame(game) {
    return tx('games', 'readwrite', function (s) { return s.put(game); });
  }

  function newId() {
    return (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  }

  // The same ENDING re-offered (reopened dialog, reload → replayed finish,
  // boot reconcile) — as opposed to a different completion that happens to
  // carry the same instance key (a cloned tab that played on divergently).
  function sameEnding(a, b) {
    return a.sans.length === b.sans.length &&
      a.sans.every(function (san, i) { return san === b.sans[i]; }) &&
      a.result === b.result && a.reason === b.reason;
  }

  // Archive a finished game; resolves with the id actually stored.
  // Idempotent per game instance AND lossless across cloned tabs: the get
  // and put run in ONE readwrite transaction (IndexedDB serializes those
  // per store), so concurrent writers cannot interleave between the read
  // and the write.
  //   - no existing record         → stored as-is
  //   - same ending re-offered     → overwritten, original createdAt kept
  //     (listGames sorts by createdAt — a re-shown old game must not jump
  //     to the top of the chronology)
  //   - different ending, SAME tab → overwritten: an ordinary replay edit
  //     (close dialog → undo → different finish) revises this instance's
  //     one record, it does not add a second game
  //   - different ending from ANOTHER (or unknown) tab → stored under a
  //     fresh id so neither tab's finished game is lost; the caller
  //     adopts the returned id for its own re-shows.
  function archiveGame(game) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        const t = db.transaction('games', 'readwrite');
        const s = t.objectStore('games');
        const getReq = s.get(game.id);
        let putReq = null;
        let storedId = game.id;
        getReq.onsuccess = function () {
          const existing = getReq.result;
          const record = Object.assign({}, game);
          if (existing) {
            const sameTab = !!existing.tab && !!record.tab && existing.tab === record.tab;
            if (sameEnding(existing, record)) {
              // Re-offering an ending is not authorship: keep the original
              // createdAt AND the original writer's tab, so a cloned tab's
              // boot reconcile cannot take ownership and later overwrite
              // the owner's game with its own divergent ending.
              record.createdAt = existing.createdAt;
              record.tab = existing.tab;
            } else if (!sameTab) {
              record.id = storedId = newId();
            }
          }
          putReq = s.put(record);
        };
        t.oncomplete = function () { resolve(storedId); };
        t.onerror = function () { reject((putReq && putReq.error) || getReq.error || t.error); };
        t.onabort = function () {
          reject((putReq && putReq.error) || getReq.error || t.error ||
            new Error('transaction aborted'));
        };
      });
    });
  }
  function getGame(id) { return tx('games', 'readonly', function (s) { return s.get(id); }); }

  function listGames() {
    return tx('games', 'readonly', function (s) { return s.getAll(); })
      .then(function (games) { return games.sort(function (a, b) { return b.createdAt - a.createdAt; }); });
  }

  global.CoachStore = {
    putGame: putGame,
    archiveGame: archiveGame,
    getGame: getGame,
    listGames: listGames
  };
})(typeof window !== 'undefined' ? window : globalThis);
