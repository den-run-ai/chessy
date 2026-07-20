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
        // A pre-release (v1–v4) context without our onversionchange
        // handler can BLOCK the upgrade indefinitely; without this the
        // promise never settles, every archive call hangs, and no failure
        // note ever appears. Reject so callers surface it; a later call
        // retries once the blocking context is gone.
        req.onblocked = function () {
          dbPromise = null;
          reject(new Error('database upgrade blocked by another open tab'));
        };
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
        // Includes 'cards': revising an ending in place must ATOMICALLY
        // remove the lesson cards flagged on the abandoned continuation.
        const t = db.transaction(['games', 'cards'], 'readwrite');
        const s = t.objectStore('games');
        const getReq = s.get(game.id);
        let putReq = null;
        let storedId = game.id;
        // A revised ending replaces the old one under the same id: cards
        // flagged on plies BEYOND the moves the two endings share now
        // reference positions this game no longer contains — remove them.
        // Cards on the shared prefix stay valid.
        function pruneCards(id, oldSans, newSans) {
          let p = 0;
          while (p < oldSans.length && p < newSans.length && oldSans[p] === newSans[p]) p++;
          const cur = t.objectStore('cards').index('gameId').openCursor(IDBKeyRange.only(id));
          cur.onsuccess = function () {
            const c = cur.result;
            if (!c) return;
            if (c.value.ply >= p) c.delete();
            c.continue();
          };
        }
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
              // Fork DETERMINISTICALLY per writer (original id + tab): the
              // same divergent completion can be re-offered more than once
              // (a boot's slot drain and its state reconcile both submit
              // it), and every attempt must land on the SAME fork — a
              // random UUID per attempt would duplicate the game. The fork
              // gets the same-ending treatment as any record.
              record.id = storedId = record.tab ? game.id + ':' + record.tab : newId();
              const forkReq = s.get(record.id);
              forkReq.onsuccess = function () {
                const fork = forkReq.result;
                if (fork && sameEnding(fork, record)) {
                  record.createdAt = fork.createdAt;
                  record.tab = fork.tab;
                } else if (fork) {
                  pruneCards(record.id, fork.sans, record.sans); // fork revised in place
                }
                putReq = s.put(record);
              };
              return;
            } else {
              pruneCards(game.id, existing.sans, record.sans); // same-tab replay edit
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

  function addCard(card) {
    return tx('cards', 'readwrite', function (s) { return s.add(card); });
  }
  function updateCard(card) {
    return tx('cards', 'readwrite', function (s) { return s.put(card); });
  }
  function listCards() { return tx('cards', 'readonly', function (s) { return s.getAll(); }); }

  function dueCards(now) {
    return tx('cards', 'readonly', function (s) {
      return s.index('due').getAll(IDBKeyRange.upperBound(now));
    }).then(function (cards) { return cards.sort(function (a, b) { return a.due - b.due; }); });
  }

  // Atomic read-modify-write for grading: `mutate` runs on the FRESH
  // stored record inside one transaction, so a concurrent grade (another
  // window, a double-fire) can never erase an appended attempt. Resolves
  // with the updated record, or null when the card is gone.
  function gradeCard(id, mutate) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        const t = db.transaction('cards', 'readwrite');
        const s = t.objectStore('cards');
        let updated = null;
        const getReq = s.get(id);
        getReq.onsuccess = function () {
          const card = getReq.result;
          if (!card) return; // deleted meanwhile — nothing to grade
          updated = mutate(card) || card;
          s.put(updated);
        };
        t.oncomplete = function () { resolve(updated); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('transaction aborted')); };
      });
    });
  }

  // ONE card per moment (gameId + ply), enforced atomically: the index
  // lookup and the write share a single readwrite transaction, so two
  // saves racing on the same moment (double-fire, second tab) cannot mint
  // two cards — the loser of the race updates the winner's card instead.
  // Resolves 'updated' when a card for the moment existed, else 'saved'.
  function upsertCardByMoment(fields, freshDefaults) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        const t = db.transaction('cards', 'readwrite');
        const s = t.objectStore('cards');
        const cur = s.index('gameId').openCursor(IDBKeyRange.only(fields.gameId));
        let outcome = 'saved';
        cur.onsuccess = function () {
          const c = cur.result;
          if (c) {
            if (c.value.ply !== fields.ply) { c.continue(); return; }
            outcome = 'updated';
            const merged = Object.assign({}, c.value, fields);
            // Attempt history is only meaningful against the move it was
            // graded on: if a re-save changed the card's canonical move,
            // the old attempts' correct/incorrect flags would silently be
            // read against the NEW move (Train, Progress). Start the
            // history over.
            const oldBest = c.value.bestMove || null;
            const newBest = fields.bestMove || null;
            const sameBest = (!oldBest && !newBest) || (!!oldBest && !!newBest &&
              oldBest.from === newBest.from && oldBest.to === newBest.to &&
              (oldBest.promotion || null) === (newBest.promotion || null));
            if (!sameBest) merged.attempts = [];
            s.put(merged);
          } else {
            s.add(Object.assign({}, freshDefaults, fields));
          }
        };
        t.oncomplete = function () { resolve(outcome); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('transaction aborted')); };
      });
    });
  }

  global.CoachStore = {
    putGame: putGame,
    archiveGame: archiveGame,
    getGame: getGame,
    listGames: listGames,
    addCard: addCard,
    updateCard: updateCard,
    upsertCardByMoment: upsertCardByMoment,
    listCards: listCards,
    dueCards: dueCards,
    gradeCard: gradeCard
  };
})(typeof window !== 'undefined' ? window : globalThis);
