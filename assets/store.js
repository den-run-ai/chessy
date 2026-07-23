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

  // While a destructive operation (restore / Delete-all) is replacing the
  // stores, REJECT training/derived writes. IndexedDB serializes transactions,
  // so a gradeCard / addCard / putAnalysis / import queued behind a slow clear
  // would commit AFTER it and recreate the cleared data, defeating the
  // operation. The destructive ops themselves (restoreAll / deleteAllData) run
  // through open() directly and are deliberately NOT gated; reads aren't gated.
  let opLock = false;
  function setOpLock(on) { opLock = !!on; }
  function opLocked() {
    return opLock ? Promise.reject(new Error('a data operation is in progress')) : null;
  }

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
    if (mode === 'readwrite' && opLock) return opLocked();
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
    return opLocked() || open().then(function (db) {
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
    return opLocked() || open().then(function (db) {
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
    return opLocked() || open().then(function (db) {
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
    return opLocked() || open().then(function (db) {
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
  // A restore CLEARS the recomputable caches too (they belong to games being
  // removed) but only re-adds the durable rows — so it opens a transaction over
  // all four stores while iterating DURABLE_STORES for the re-add.
  var RESTORE_STORES = ['games', 'cards', 'analyses', 'analysisJobs'];

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

  // ---- Restore (Phase 4b3) ---------------------------------------------
  // A value usable as an IndexedDB key: string, finite number, valid Date, or
  // an array of those. A record whose keyPath value is anything else would make
  // store.add() throw SYNCHRONOUSLY (DataError) — caught in-transaction below,
  // but rejecting it here means a known-bad backup never opens a transaction.
  function validIdbKey(v) {
    var tp = typeof v;
    if (tp === 'string') return true;
    if (tp === 'number') return isFinite(v);
    if (v instanceof Date) return !isNaN(v.getTime());
    if (Array.isArray(v)) return v.length > 0 && v.every(validIdbKey);
    return false;
  }

  // Strict structural FEN check (Chess.parseFen is deliberately lenient, so it
  // would accept "bad" and yield a broken position that Train's
  // Chess.parseFen(card.fenBefore) then chokes on). Mirrors the six-field
  // validation in pgn.js: 8 ranks each summing to 8 valid squares, exactly one
  // king per side, a legal side to move, and numeric counters. Self-contained
  // so store.js keeps no dependency on the later-loading pgn.js.
  function validFen(fen) {
    if (typeof fen !== 'string') return false;
    var parts = fen.trim().split(/\s+/);
    if (parts.length !== 6) return false;
    var rows = parts[0].split('/');
    if (rows.length !== 8) return false;
    var wk = 0, bk = 0;
    for (var ri = 0; ri < rows.length; ri++) {
      var count = 0;
      for (var ci = 0; ci < rows[ri].length; ci++) {
        var ch = rows[ri][ci];
        if (/[1-8]/.test(ch)) count += Number(ch);
        else if (/[prnbqkPRNBQK]/.test(ch)) { count += 1; if (ch === 'K') wk++; if (ch === 'k') bk++; }
        else return false;
      }
      if (count !== 8) return false;
    }
    if (wk !== 1 || bk !== 1) return false;
    if (parts[1] !== 'w' && parts[1] !== 'b') return false;
    if (!/^(-|K?Q?k?q?)$/.test(parts[2]) || parts[2] === '') return false;
    if (!/^(-|[a-h][36])$/.test(parts[3])) return false;
    if (!/^\d+$/.test(parts[4])) return false;      // halfmove clock
    if (!/^[1-9]\d*$/.test(parts[5])) return false; // fullmove number (>= 1)
    return true;
  }

  // Validate a parsed backup WITHOUT touching the database: format, a version
  // no NEWER than this build understands, and every durable record's key and
  // minimal schema. Returns an error string, or null when it is safe to
  // restore. Rejecting here keeps the restore atomic — a malformed backup never
  // gets a partial write.
  function validateBackup(data) {
    if (!data || typeof data !== 'object') return 'not a backup object';
    if (data.format !== BACKUP_FORMAT) return 'unrecognised backup format';
    // Every backup this app writes carries integer version fields. REQUIRE them
    // (not merely "reject if newer"): a truncated file retaining only the
    // format tag and empty stores must not be treated as a compatible v-nothing
    // backup and allowed to erase the archive.
    if (!Number.isInteger(data.version) || data.version < 1) {
      return 'backup has no valid version';
    }
    if (data.version > BACKUP_VERSION) return 'backup is from a newer app version';
    if (!Number.isInteger(data.dbVersion) || data.dbVersion < 1) {
      return 'backup has no valid database version';
    }
    if (data.dbVersion > DB_VERSION) return 'backup is from a newer database schema';
    // Must be a plain object: an ARRAY passes `typeof === 'object'` but then
    // every named store reads as absent, so a `stores: []` backup would clear
    // the archive while "restoring" zero records.
    if (!data.stores || typeof data.stores !== 'object' || Array.isArray(data.stores)) {
      return 'backup has no stores';
    }
    // Every v1 export includes BOTH durable arrays. Require them explicitly: a
    // truncated `stores: {}` (each named store merely absent) would otherwise
    // pass, report zero records, and let restoreAll() clear all four stores
    // while adding nothing.
    if (!Array.isArray(data.stores.games) || !Array.isArray(data.stores.cards)) {
      return 'backup is missing the games or cards array';
    }
    for (var i = 0; i < DURABLE_STORES.length; i++) {
      var name = DURABLE_STORES[i];
      var rows = data.stores[name];
      if (rows === undefined) continue; // a store may legitimately be absent/empty
      if (!Array.isArray(rows)) return 'store "' + name + '" is not an array';
      for (var j = 0; j < rows.length; j++) {
        var r = rows[j];
        if (!r || typeof r !== 'object') return 'store "' + name + '" has a non-object record';
        if (!validIdbKey(r.id)) return 'store "' + name + '" record ' + j + ' has an invalid "id" key';
        // Required schema so a restored record is USABLE, not merely addable:
        // a game must replay AND render in Review; a card must attach to a game
        // AND be trainable. Otherwise the destructive restore swaps in records
        // that later blow up the view or the training load.
        if (name === 'games') {
          if (typeof r.id !== 'string' || !Array.isArray(r.sans)) {
            return 'store "games" record ' + j + ' is missing required fields';
          }
          // Review renders result / plies / createdAt directly; missing values
          // show as "undefined", "NaN moves", "Invalid Date".
          if (typeof r.result !== 'string' || !r.result) {
            return 'store "games" record ' + j + ' is missing a result';
          }
          if (!Number.isFinite(r.plies)) {
            return 'store "games" record ' + j + ' has a non-numeric plies';
          }
          if (!Number.isFinite(r.createdAt)) {
            return 'store "games" record ' + j + ' has a non-numeric createdAt';
          }
        }
        if (name === 'cards') {
          if (typeof r.gameId !== 'string') {
            return 'store "cards" record ' + j + ' is missing a gameId';
          }
          // Train dereferences fenBefore (Chess.parseFen) and schedules on due;
          // an unparseable FEN drops the WHOLE training load into its "Archive
          // unavailable" path, and a non-numeric due breaks the due index.
          if (!validFen(r.fenBefore)) {
            return 'store "cards" record ' + j + ' has an invalid fenBefore';
          }
          if (!Number.isFinite(r.due)) {
            return 'store "cards" record ' + j + ' has a non-numeric due';
          }
          // Progress iterates `for (const a of attempts)` and Train grading
          // does `(attempts || []).concat(...)`; a non-array (e.g. {}) is truthy
          // so it slips the `|| []` guard and throws. Missing is fine (treated
          // as empty); present-but-not-an-array is rejected.
          if (r.attempts !== undefined && !Array.isArray(r.attempts)) {
            return 'store "cards" record ' + j + ' has a non-array attempts';
          }
          // Train.schedule() uses card.step as an INDEX into a fixed ladder
          // (LADDER_DAYS, 6 rungs) — LADDER_DAYS[card.step] — with -1 the
          // immediate-learn rung reflection sets. A fractional step (0.5) or one
          // below -1 indexes off the ladder to `undefined`, so the first grade
          // stores due:NaN, which the IndexedDB `due` index cannot schedule.
          // Require an integer in the supported domain; steps above the top rung
          // are clamped by schedule() and so are harmless.
          if (!Number.isInteger(r.step) || r.step < -1) {
            return 'store "cards" record ' + j + ' has an out-of-range step';
          }
        }
      }
    }
    return null;
  }

  // Replace the DURABLE archive with a validated backup, ATOMICALLY: one
  // read-write transaction clears games+cards and re-adds the backup's rows.
  // Validated in memory first (invalid → rejected, zero writes). Crucially, a
  // SYNCHRONOUS enqueue failure (an invalid key that slipped validation) must
  // NOT let the preceding clear() auto-commit and destroy the archive: the loop
  // is wrapped so any throw explicitly aborts the whole transaction, rolling
  // the clear back. Any async request error aborts the transaction too (IDB
  // atomicity), so a restore either fully lands or leaves the archive exactly
  // as it was. Resolves with per-store counts.
  function restoreAll(data) {
    var err = validateBackup(data);
    if (err) return Promise.reject(new Error('invalid backup: ' + err));
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        // The backup deliberately omits the recomputable engine caches, but the
        // replacement must still CLEAR them in the SAME atomic transaction:
        // analyses and analysisJobs keyed to games the restore removes are no
        // longer reachable yet keep consuming quota, which can later fail game
        // or card writes. Clear all four, re-add only the durable backup rows.
        var t = db.transaction(RESTORE_STORES, 'readwrite');
        var counts = {};
        var failed = null;
        t.oncomplete = function () { resolve(counts); };
        t.onerror = function () { reject(failed || t.error || new Error('restore failed')); };
        t.onabort = function () { reject(failed || t.error || new Error('restore aborted')); };
        try {
          RESTORE_STORES.forEach(function (name) { t.objectStore(name).clear(); });
          DURABLE_STORES.forEach(function (name) {
            var store = t.objectStore(name);
            var rows = (data.stores[name] || []);
            counts[name] = rows.length;
            rows.forEach(function (r) { store.add(r); }); // may throw synchronously on a bad key
          });
        } catch (e) {
          // Explicit abort so the clear() cannot commit: without this the
          // transaction would still flush the queued clear and wipe the archive
          // even though the restore "failed".
          failed = e;
          try { t.abort(); } catch (e2) { /* already aborting */ }
        }
      });
    });
  }

  // ---- Delete all (Phase 4b4) ------------------------------------------
  // Clear EVERY store — durable and recomputable alike — in one transaction.
  // The fenced UI (dialog + explicit confirm) plus the recovery fence the
  // caller applies ONLY on success (cancel analysis, suspend live writes, fence
  // the cleared endings by signature, drop the durability queue) guarantee
  // cleared games do not reappear, including after a reload.
  function deleteAllData() {
    var all = RESTORE_STORES; // games, cards, analyses, analysisJobs
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(all, 'readwrite');
        all.forEach(function (name) { t.objectStore(name).clear(); });
        t.oncomplete = function () { resolve(true); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('delete aborted')); };
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
    exportAll: exportAll,
    validateBackup: validateBackup,
    validFen: validFen,
    restoreAll: restoreAll,
    deleteAllData: deleteAllData,
    setOpLock: setOpLock
  };
})(typeof window !== 'undefined' ? window : globalThis);
