/*
 * Chessy coaching store — the IndexedDB archive behind the coaching
 * features (roadmap #23). Object stores:
 *
 *   games: { id (the game's UUID from app.js), source ('play'), tags,
 *            sans, playerColor, clocks, result, reason, mode, difficulty,
 *            timeControl, plies, createdAt }
 *   cards: { id (auto), gameId, ply, ... } — lesson cards
 *   analyses: { key, gameId, ply, ... } — one bounded engine analysis per
 *            (game, ply, position fingerprint, engine, config); the caller
 *            builds `key` via analysisKey() so the SAME FEN reached with a
 *            different repetition history is a DISTINCT entry.
 *   analysisJobs: { gameId, state, cursorPly, moments, ... } — one
 *            reload-safe, resumable two-pass scan per game (Phase 5).
 *
 * The games keyPath is the app's own per-game UUID: a re-shown or revised
 * ending of the same game instance (reload, undo → replay, reopened
 * game-over dialog) overwrites its single record via archiveGame(), while
 * New game/Rematch mint a new UUID and therefore a new record. The store
 * assumes ONE ACTIVE TAB, like the rest of the app (the localStorage save
 * is last-writer-wins); cross-tab semantics are deferred to #44.
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
  // v5 was the FIRST released schema (v1–v4 only ever existed on pre-release
  // preview branches). v6 adds the analyses + analysisJobs stores.
  //
  // MIGRATIONS ARE NON-DESTRUCTIVE from v5 on. The old code unconditionally
  // deleted EVERY object store in onupgradeneeded and recreated them — safe
  // only because v1–v4 were throwaway previews with no data worth keeping.
  // Applying that to a v5→v6 bump would ERASE every shipped game and lesson
  // card. So we now create only the stores that don't exist yet (fresh
  // install, or a wiped preview) and leave existing v5 data untouched. The
  // preview wipe is scoped to genuinely pre-release versions (oldVersion in
  // 1..4) — never to released data.
  const DB_VERSION = 6;

  let dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise(function (resolve, reject) {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = function (e) {
          const db = req.result;
          // A pre-release preview (v1–v4) may hold an incompatible layout
          // and NO data worth migrating — wipe it. A fresh install
          // (oldVersion 0) and any released version (>= 5) are never wiped.
          if (e.oldVersion >= 1 && e.oldVersion < 5) {
            for (const name of Array.from(db.objectStoreNames)) {
              db.deleteObjectStore(name);
            }
          }
          // Create-if-absent: existing v5 stores (and their data) survive.
          if (!db.objectStoreNames.contains('games')) {
            db.createObjectStore('games', { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains('cards')) {
            const cards = db.createObjectStore('cards', { keyPath: 'id', autoIncrement: true });
            cards.createIndex('due', 'due');
            cards.createIndex('gameId', 'gameId');
          }
          // v6 stores. keyPath 'key' on analyses (caller-built composite);
          // gameId/ply indexed so a game revision can prune stale analyses
          // exactly like cards. One job per game (keyPath 'gameId').
          if (!db.objectStoreNames.contains('analyses')) {
            const analyses = db.createObjectStore('analyses', { keyPath: 'key' });
            analyses.createIndex('gameId', 'gameId');
            analyses.createIndex('gamePly', ['gameId', 'ply']);
          }
          if (!db.objectStoreNames.contains('analysisJobs')) {
            const jobs = db.createObjectStore('analysisJobs', { keyPath: 'gameId' });
            jobs.createIndex('state', 'state');
          }
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

  // The same ENDING re-offered (reopened dialog, reload → replayed finish,
  // boot reconcile) — as opposed to a REVISED completion of the instance
  // (close dialog → undo → different finish).
  function sameEnding(a, b) {
    return a.sans.length === b.sans.length &&
      a.sans.every(function (san, i) { return san === b.sans[i]; }) &&
      a.result === b.result && a.reason === b.reason;
  }

  // Archive a finished game; resolves with the stored id. The get and put
  // run in ONE readwrite transaction, so a re-offer racing a write cannot
  // interleave.
  //   - no existing record     → stored as-is
  //   - same ending re-offered → overwritten, keeping the EARLIEST known
  //     completion time (listGames sorts by createdAt — a re-shown or
  //     late-reconciled game must not jump the chronology)
  //   - different ending       → overwritten: the instance was revised
  //     (undo → different finish); one instance, one record.
  // SINGLE-TAB model by design: the archive assumes one active tab, like
  // the rest of the app (last-writer-wins localStorage save). Divergent
  // cloned-tab completions are out of scope — tracked in #44.
  function archiveGame(game) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        // Includes 'cards'/'analyses'/'analysisJobs': revising an ending in
        // place must ATOMICALLY remove the derived data (lesson cards,
        // engine analyses, scan progress) flagged on the abandoned
        // continuation, in the same transaction that rewrites the game.
        const t = db.transaction(['games', 'cards', 'analyses', 'analysisJobs'], 'readwrite');
        const s = t.objectStore('games');
        const getReq = s.get(game.id);
        let putReq = null;
        // A revised ending replaces the old one under the same id. Anything
        // derived from plies BEYOND the moves the two endings share now
        // references positions this game no longer contains; prune from the
        // FIRST DIVERGENT ply, leaving the shared prefix intact.
        function pruneFromDivergence(id, oldSans, newSans) {
          let p = 0;
          while (p < oldSans.length && p < newSans.length && oldSans[p] === newSans[p]) p++;
          // Cards flagged past the divergence.
          const cc = t.objectStore('cards').index('gameId').openCursor(IDBKeyRange.only(id));
          cc.onsuccess = function () {
            const c = cc.result;
            if (!c) return;
            if (c.value.ply >= p) c.delete();
            c.continue();
          };
          // Engine analyses of positions past the divergence are stale.
          const ac = t.objectStore('analyses').index('gameId').openCursor(IDBKeyRange.only(id));
          ac.onsuccess = function () {
            const a = ac.result;
            if (!a) return;
            if (a.value.ply >= p) a.delete();
            a.continue();
          };
          // The resumable scan: drop found moments past the divergence and
          // rewind the cursor to it so a resume re-scans the changed tail. A
          // job whose progress is entirely within the shared prefix
          // (cursorPly <= p, no later moments) is left untouched.
          const jr = t.objectStore('analysisJobs').get(id);
          jr.onsuccess = function () {
            const job = jr.result;
            if (!job) return;
            const moments = (job.moments || []).filter(function (m) { return m.ply < p; });
            const cursorPly = typeof job.cursorPly === 'number'
              ? Math.min(job.cursorPly, p) : job.cursorPly;
            if (moments.length === (job.moments || []).length && cursorPly === job.cursorPly) return;
            job.moments = moments;
            job.cursorPly = cursorPly;
            if (job.state === 'done') job.state = 'paused'; // reached removed territory: resume
            t.objectStore('analysisJobs').put(job);
          };
        }
        getReq.onsuccess = function () {
          const existing = getReq.result;
          const record = Object.assign({}, game);
          if (existing) {
            if (sameEnding(existing, record)) {
              record.createdAt = Math.min(existing.createdAt, record.createdAt);
            } else {
              pruneFromDivergence(game.id, existing.sans, record.sans); // revised ending
            }
          }
          putReq = s.put(record);
        };
        t.oncomplete = function () { resolve(game.id); };
        t.onerror = function () { reject((putReq && putReq.error) || getReq.error || t.error); };
        t.onabort = function () {
          reject((putReq && putReq.error) || getReq.error || t.error ||
            new Error('transaction aborted'));
        };
      });
    });
  }
  function getGame(id) { return tx('games', 'readonly', function (s) { return s.get(id); }); }

  // Import a validated PGN record (see ChessyPGN.toRecord). DEDUPED by its id
  // (external id or content hash): the lookup and the write share ONE
  // transaction, so a record already present is left as-is and a repeated
  // import yields a single game. Resolves 'imported' or 'duplicate'. The
  // record must already be fully validated — this only persists it (commit
  // once, atomically).
  function importGame(record) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        const t = db.transaction('games', 'readwrite');
        const s = t.objectStore('games');
        const getReq = s.get(record.id);
        let outcome = 'imported';
        getReq.onsuccess = function () {
          if (getReq.result) { outcome = 'duplicate'; return; } // already have it
          s.add(record);
        };
        t.oncomplete = function () { resolve(outcome); };
        t.onerror = function () { reject(getReq.error || t.error); };
        t.onabort = function () { reject(getReq.error || t.error || new Error('transaction aborted')); };
      });
    });
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
  function listCards() { return tx('cards', 'readonly', function (s) { return s.getAll(); }); }

  function dueCards(now) {
    return tx('cards', 'readonly', function (s) {
      return s.index('due').getAll(IDBKeyRange.upperBound(now));
    }).then(function (cards) { return cards.sort(function (a, b) { return a.due - b.due; }); });
  }

  // Atomic read-modify-write for grading: `mutate` runs on the FRESH
  // stored record inside one transaction. `expect` pins the grade to the
  // card revision the player was actually shown — {due, attempts: count}
  // at presentation time. IndexedDB serializes the transactions, so
  // without this check the LOSER of a concurrent grade (another window
  // showing the same due card) would run its mutate on the freshly
  // updated card and append a second attempt / climb a second rung; with
  // it, the stale grade is rejected inside the same transaction.
  // Resolves with the updated record, 'stale' when the expected revision
  // was already consumed, or null when the card is gone.
  function gradeCard(id, expect, mutate) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        const t = db.transaction('cards', 'readwrite');
        const s = t.objectStore('cards');
        let outcome = null;
        const getReq = s.get(id);
        getReq.onsuccess = function () {
          const card = getReq.result;
          if (!card) return; // deleted meanwhile — nothing to grade
          if (expect && (card.due !== expect.due ||
              (card.attempts || []).length !== expect.attempts)) {
            outcome = 'stale';
            return;
          }
          outcome = mutate(card) || card;
          s.put(outcome);
        };
        t.oncomplete = function () { resolve(outcome); };
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

  // ---- analyses (Phase 1/5) --------------------------------------------
  // One stored analysis per (game, ply, position fingerprint, engine,
  // config). The key MUST fold in everything that can change the result:
  // notably the position fingerprint carries the repetition context, so the
  // SAME FEN reached with a different history — which can score differently
  // (a move that completes a threefold is a draw) — is a distinct entry.
  function analysisKey(gameId, ply, positionFingerprint, engineId, configHash) {
    return [gameId, ply, positionFingerprint, engineId, configHash].join('|');
  }
  function putAnalysis(rec) {
    return tx('analyses', 'readwrite', function (s) { return s.put(rec); });
  }
  function getAnalysis(key) {
    return tx('analyses', 'readonly', function (s) { return s.get(key); });
  }
  // Evict a single cached analysis by key. The reflection layer applies rules
  // the store/service cannot (per-line legality + SAN); when it rejects a
  // served result as unusable it evicts the entry so a retry re-runs the worker
  // instead of serving the same bad cache forever.
  function deleteAnalysis(key) {
    return tx('analyses', 'readwrite', function (s) { return s.delete(key); });
  }
  function listAnalysesForGame(gameId) {
    return tx('analyses', 'readonly', function (s) {
      return s.index('gameId').getAll(IDBKeyRange.only(gameId));
    });
  }

  // ---- analysisJobs (Phase 5) ------------------------------------------
  // One resumable, reload-safe two-pass scan per game, keyed on gameId:
  //   { gameId, state, cursorPly, moments: [{ ply, ... }], engine, config,
  //     updatedAt }
  // archiveGame() prunes a job from the first divergent ply when its game is
  // revised, so a resume never trusts progress over positions that changed.
  function putJob(job) {
    return tx('analysisJobs', 'readwrite', function (s) { return s.put(job); });
  }
  function getJob(gameId) {
    return tx('analysisJobs', 'readonly', function (s) { return s.get(gameId); });
  }
  function deleteJob(gameId) {
    return tx('analysisJobs', 'readwrite', function (s) { return s.delete(gameId); });
  }

  // ---- Backup (Phase 4b2) ----------------------------------------------
  // A versioned JSON snapshot of the DURABLE stores only. games and cards
  // carry everything the user cannot recompute — archived games with clocked
  // moves, and lesson cards with their reflections, attempt history and
  // spaced-review scheduling. `analyses`/`analysisJobs` are engine caches and
  // resumable scan progress: recomputable from the games, so they are OMITTED
  // to keep backups small and portable. `version` is the backup-format
  // version; `dbVersion` is the schema the backup was taken from, so a restore
  // can refuse a backup from a FUTURE schema it cannot understand.
  var BACKUP_FORMAT = 'chessy-coach-backup';
  var BACKUP_VERSION = 1;
  var DURABLE_STORES = ['games', 'cards'];

  function exportAll() {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(DURABLE_STORES, 'readonly');
        var out = { format: BACKUP_FORMAT, version: BACKUP_VERSION, dbVersion: DB_VERSION,
          exportedAt: Date.now(), stores: {} };
        DURABLE_STORES.forEach(function (name) {
          var req = t.objectStore(name).getAll();
          req.onsuccess = function () { out.stores[name] = req.result; };
        });
        t.oncomplete = function () { resolve(out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('transaction aborted')); };
      });
    });
  }

  global.CoachStore = {
    putGame: putGame,
    archiveGame: archiveGame,
    importGame: importGame,
    getGame: getGame,
    listGames: listGames,
    addCard: addCard,
    updateCard: updateCard,
    upsertCardByMoment: upsertCardByMoment,
    listCards: listCards,
    dueCards: dueCards,
    gradeCard: gradeCard,
    analysisKey: analysisKey,
    putAnalysis: putAnalysis,
    getAnalysis: getAnalysis,
    deleteAnalysis: deleteAnalysis,
    listAnalysesForGame: listAnalysesForGame,
    putJob: putJob,
    getJob: getJob,
    deleteJob: deleteJob,
    exportAll: exportAll
  };
})(typeof window !== 'undefined' ? window : globalThis);
